//! Paged object metadata. Only compact listing rows and byte locators stay in
//! memory; complete field tables are fetched for the selected working object.
use super::*;
use futureox_design_kernel::large_json::Entry;
use std::sync::{Arc, atomic::AtomicUsize};

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Row {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub parent: Option<usize>,
    pub depth: usize,
    pub span: Span,
    pub member: Span,
}
impl Row {
    fn from_entry(e: &Entry) -> Self {
        Self {
            id: if e.id.len() <= 128 {
                e.id.clone()
            } else {
                format!("json:{}", e.span.start)
            },
            name: e.name.chars().take(160).collect(),
            kind: e.kind.chars().take(64).collect(),
            parent: e.parent,
            depth: e.depth,
            span: e.span,
            member: e.member,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Edit {
    span: Span,
    length: u64,
}
#[derive(Default)]
struct Navigation {
    offsets: Vec<usize>,
    children: Vec<usize>,
    roots: Vec<usize>,
    names: Vec<Option<String>>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct DiskIndex {
    #[serde(skip)]
    navigation: Arc<Navigation>,
    #[serde(skip)]
    backing: RecordBacking,
    pub bytes: u64,
    pub entries: Vec<Row>,
    locations: Vec<Span>,
    generations: Vec<usize>,
    edits: Vec<Edit>,
    data: String,
}

#[derive(Clone, Default)]
enum RecordBacking {
    #[default]
    Workspace,
    Temporary(Arc<TemporaryIndexDirectory>),
    RecoveryMemory(Arc<Vec<u8>>),
}

struct TemporaryIndexDirectory(PathBuf);

impl TemporaryIndexDirectory {
    fn create(root: &Path) -> Result<Arc<Self>> {
        let path = root.join(format!("futureox-source-index-{}", crate::unique_id()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(save_io)?;
        Ok(Arc::new(Self(path)))
    }
}

impl Drop for TemporaryIndexDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct RecoveryRecordBuffer {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for RecoveryRecordBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let full = || io::Error::new(io::ErrorKind::StorageFull, "Source recovery index exceeds its memory allowance");
        let end = self.bytes.len().checked_add(bytes.len()).filter(|end| *end <= self.limit).ok_or_else(full)?;
        if end > self.bytes.capacity() {
            let requested = end.next_power_of_two().min(self.limit);
            self.bytes.try_reserve_exact(requested - self.bytes.len())
                .map_err(|error| io::Error::new(io::ErrorKind::StorageFull, error))?;
            if self.bytes.capacity() > self.limit {
                return Err(full());
            }
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

struct UnpublishedRecords(Option<PathBuf>);

impl Drop for UnpublishedRecords {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

const STREAM_CHUNK: usize = 64 * 1024;
const ENTRY_MAGIC: &[u8; 4] = b"FXE1";
fn push_u32(out: &mut Vec<u8>, value: u32) { out.extend_from_slice(&value.to_le_bytes()); }
fn push_u64(out: &mut Vec<u8>, value: u64) { out.extend_from_slice(&value.to_le_bytes()); }
fn push_str(out: &mut Vec<u8>, value: &str) -> io::Result<()> {
    let len = u32::try_from(value.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Index record string is too long"))?;
    push_u32(out, len);
    out.extend_from_slice(value.as_bytes());
    Ok(())
}
fn push_span(out: &mut Vec<u8>, span: large_json::Span) {
    push_u64(out, span.start);
    push_u64(out, span.end);
}
/// Same Entry the JSON side file stored, without a second serde document.
/// Rows still own navigation identity; this record is only the field table.
fn encode_entry(entry: &large_json::Entry, out: &mut Vec<u8>) -> io::Result<()> {
    out.clear();
    out.extend_from_slice(ENTRY_MAGIC);
    push_str(out, &entry.id)?;
    push_str(out, &entry.name)?;
    push_str(out, &entry.kind)?;
    push_span(out, entry.member);
    push_span(out, entry.span);
    match entry.parent {
        Some(parent) => {
            out.push(1);
            push_u64(out, u64::try_from(parent).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Index parent does not fit"))?);
        }
        None => out.push(0),
    }
    push_u64(out, u64::try_from(entry.depth).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Index depth does not fit"))?);
    let count = u32::try_from(entry.fields.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Index field count does not fit"))?;
    push_u32(out, count);
    for field in &entry.fields {
        push_str(out, &field.key)?;
        push_span(out, field.member);
        push_span(out, field.value);
    }
    Ok(())
}
struct EntryCursor<'a> { bytes: &'a [u8], at: usize }
impl EntryCursor<'_> {
    fn take(&mut self, n: usize) -> io::Result<&[u8]> {
        let end = self.at.checked_add(n).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Invalid index record"))?;
        if end > self.bytes.len() { return Err(io::Error::new(io::ErrorKind::InvalidData, "Truncated index record")); }
        let value = &self.bytes[self.at..end];
        self.at = end;
        Ok(value)
    }
    fn u32(&mut self) -> io::Result<u32> { Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap())) }
    fn u64(&mut self) -> io::Result<u64> { Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
    fn string(&mut self) -> io::Result<String> {
        let n = self.u32()? as usize;
        let bytes = self.take(n)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Index record is not UTF-8"))
    }
    fn span(&mut self) -> io::Result<large_json::Span> {
        let start = self.u64()?;
        let end = self.u64()?;
        if end < start {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Reversed index span"));
        }
        Ok(large_json::Span { start, end })
    }
}
fn decode_entry(bytes: &[u8]) -> io::Result<large_json::Entry> {
    let mut cursor = EntryCursor { bytes, at: 0 };
    if cursor.take(4)? != ENTRY_MAGIC { return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid index record")); }
    let id = cursor.string()?;
    let name = cursor.string()?;
    let kind = cursor.string()?;
    let member = cursor.span()?;
    let span = cursor.span()?;
    let parent = match cursor.take(1)? {
        [0] => None,
        [1] => Some(usize::try_from(cursor.u64()?).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Index parent does not fit"))?),
        _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid index parent")),
    };
    let depth = usize::try_from(cursor.u64()?).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Index depth does not fit"))?;
    let count = cursor.u32()? as usize;
    // Even an empty key needs its length and two full spans.
    const MIN_FIELD_BYTES: usize = 4 + 2 * (8 + 8);
    if count > (bytes.len() - cursor.at) / MIN_FIELD_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid index field count"));
    }
    let mut fields = Vec::new();
    fields.try_reserve_exact(count).map_err(io::Error::other)?;
    for _ in 0..count {
        fields.push(large_json::Field { key: cursor.string()?, member: cursor.span()?, value: cursor.span()? });
    }
    if cursor.at != bytes.len() { return Err(io::Error::new(io::ErrorKind::InvalidData, "Index record has trailing bytes")); }
    Ok(large_json::Entry { member, id, name, kind, parent, depth, span, fields })
}
/// New indexes write compact records. A working copy saved by an older build
/// still has JSON records; both decode to the same Entry.
fn decode_stored_entry(bytes: &[u8]) -> io::Result<large_json::Entry> {
    if bytes.starts_with(ENTRY_MAGIC) { decode_entry(bytes) }
    else { serde_json::from_slice(bytes).map_err(io::Error::other) }
}
pub(super) struct ChunkReader {
    receiver: std::sync::mpsc::Receiver<Vec<u8>>,
    current: std::io::Cursor<Vec<u8>>,
}

enum RecordReader<'a> {
    File(File),
    Memory(io::Cursor<&'a [u8]>),
}

/// One immutable index owner and its record reader. A layout pass borrows
/// this rather than opening the same index once for every scalar field.
pub(super) struct Records<'a> { index: &'a DiskIndex, reader: RecordReader<'a> }
impl Records<'_> {
    pub fn entry(&mut self, n: usize) -> Result<Entry> {
        match &mut self.reader {
            RecordReader::File(file) => self.index.entry_from(n, file),
            RecordReader::Memory(cursor) => self.index.entry_from(n, cursor),
        }
    }
}
impl Read for ChunkReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() { return Ok(0); }
        loop {
            let n = self.current.read(out)?;
            if n > 0 { return Ok(n); }
            match self.receiver.recv() {
                Ok(bytes) => self.current = std::io::Cursor::new(bytes),
                Err(_) => return Ok(0),
            }
        }
    }
}

/// Decode/spool/hash on this thread while one bounded consumer parses the same bytes.
pub(super) fn pipe<T:Send>(mut reader:impl Read,consume:impl FnOnce(ChunkReader)->Result<T>+Send)->Result<T> {
    std::thread::scope(|scope| {
            let (sender, receiver) = std::sync::mpsc::sync_channel(2);
            let parser = scope.spawn(move || consume(ChunkReader {
                receiver, current: std::io::Cursor::new(Vec::new()),
            }));
            let producer = (|| -> io::Result<()> {
                loop {
                    let mut bytes = vec![0; STREAM_CHUNK];
                    let count = reader.read(&mut bytes)?;
                    if count == 0 { return Ok(()); }
                    bytes.truncate(count);
                    // A parser rejection drops its receiver; stop decoding
                    // promptly instead of consuming the rest of a huge member.
                    if sender.send(bytes).is_err() { return Ok(()); }
                }
            })();
            drop(sender);
            let parsed = parser.join().map_err(|_| issue("Source index worker failed"))?;
            // A valid JSON prefix does not excuse a later archive CRC/read
            // failure. Preserve cancellation and I/O errors from the producer.
            producer.map_err(issue)?;
            parsed
        })
    }

impl DiskIndex {
    pub fn build_pipelined(reader:impl Read, limit:u64, directory:&Path)->Result<Self> {
        pipe(reader,|stream|Self::build(stream,limit,directory))
    }
    pub fn build(reader: impl Read, limit: u64, directory: &Path) -> Result<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let data = format!(
            "index-data-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(issue)?
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let path = directory.join(&data);
        let mut unpublished = UnpublishedRecords(None);
        let mut writer = BufWriter::new(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(save_io)?,
        );
        unpublished.0 = Some(path);
        let mut result = Self::scan_records(reader, limit, &mut writer)?;
        writer.flush().map_err(save_io)?;
        writer.get_ref().sync_all().map_err(save_io)?;
        result.data = data;
        result.refresh_navigation();
        unpublished.0 = None;
        Ok(result)
    }

    fn scan_records(reader: impl Read, limit: u64, writer: &mut impl Write) -> Result<Self> {
        let mut entries = Vec::new();
        let mut locations = Vec::new();
        let mut at = 0;
        let mut scratch = Vec::new();
        let summary = large_json::scan(reader, limit, |ordinal, entry| {
            if entries.len() <= ordinal {
                entries.resize_with(ordinal + 1, Row::default);
                locations.resize(ordinal + 1, Span::default());
            }
            encode_entry(&entry, &mut scratch)?;
            writer.write_all(&scratch)?;
            let bytes_len = scratch.len() as u64;
            locations[ordinal] = Span {
                start: at,
                end: at + bytes_len,
            };
            at += bytes_len;
            entries[ordinal] = Row::from_entry(&entry);
            Ok(())
        })
        .map_err(save_io)?;
        Ok(Self {
            navigation: Arc::default(),
            backing: RecordBacking::Workspace,
            bytes: summary.bytes,
            generations: vec![0; entries.len()],
            entries,
            locations,
            edits: Vec::new(),
            data: String::new(),
        })
    }

    /// Only recovery uses a disposable index on a writable volume. The
    /// retained source, revisions and journal still belong to the workspace.
    pub(super) fn build_temporary(rebuild: impl FnOnce(&Path) -> Result<Self>) -> Result<Self> {
        let root = std::env::temp_dir().canonicalize().map_err(save_io)?;
        let directory = TemporaryIndexDirectory::create(&root)?;
        let mut index = rebuild(&directory.0)?;
        index.backing = RecordBacking::Temporary(directory);
        Ok(index)
    }

    /// Rebuild verified checkpoint field tables when neither volume can host
    /// a disposable file. Charge all in-memory parts to one recovery allowance.
    pub(super) fn build_in_memory(reader: impl Read, limit: u64, remaining: &mut usize) -> Result<Self> {
        let mut writer = RecoveryRecordBuffer { bytes: Vec::new(), limit: *remaining };
        let mut index = Self::scan_records(reader, limit, &mut writer)?;
        *remaining -= writer.bytes.capacity();
        index.backing = RecordBacking::RecoveryMemory(Arc::new(writer.bytes));
        index.refresh_navigation();
        Ok(index)
    }

    fn records_path(&self, directory: &Path) -> PathBuf {
        let directory = match &self.backing {
            RecordBacking::Temporary(temporary) => &temporary.0,
            _ => directory,
        };
        directory.join(&self.data)
    }
    pub fn refresh_navigation(&mut self) {
        let count = self.entries.len();
        let mut offsets = vec![0usize; count + 1];
        let mut roots = Vec::new();
        for (n, row) in self.entries.iter().enumerate() {
            if let Some(parent) = row.parent {
                offsets[parent + 1] += 1;
            } else {
                roots.push(n);
            }
        }
        for i in 1..offsets.len() {
            offsets[i] += offsets[i - 1];
        }
        let mut children = vec![0usize; offsets[count] as usize];
        let mut next = offsets.clone();
        for (n, row) in self.entries.iter().enumerate() {
            if let Some(parent) = row.parent {
                children[next[parent] as usize] = n;
                next[parent] += 1;
            }
        }
        // Native-width locators do not impose a product row-count quota.
        // Cache only short lowercase names; long names are searched on demand.
        let names = self
            .entries
            .iter()
            .map(|row| {
                let name = row.name.to_lowercase();
                (name.len() <= 24).then_some(name)
            })
            .collect();
        self.navigation = Arc::new(Navigation {
            offsets,
            children,
            roots,
            names,
        });
    }
    pub fn children(&self, parent: Option<usize>) -> &[usize] {
        match parent {
            None => &self.navigation.roots,
            Some(n) => {
                &self.navigation.children
                    [self.navigation.offsets[n] as usize..self.navigation.offsets[n + 1] as usize]
            }
        }
    }
    pub fn has_children(&self, n: usize) -> bool {
        self.navigation.offsets[n] != self.navigation.offsets[n + 1]
    }
    pub fn name_matches(&self, n: usize, query: &str) -> bool {
        self.navigation.names[n].as_ref().map_or_else(
            || self.entries[n].name.to_lowercase().contains(query),
            |name| name.contains(query),
        )
    }
    pub fn entry(&self, n: usize, directory: &Path) -> Result<Entry> {
        if n >= self.entries.len() { return Err(issue("Unknown source object")); }
        self.records(directory)?.entry(n)
    }
    pub fn records(&self, directory: &Path) -> Result<Records<'_>> {
        let reader = match &self.backing {
            RecordBacking::RecoveryMemory(bytes) => RecordReader::Memory(io::Cursor::new(bytes.as_slice())),
            _ => RecordReader::File(File::open(self.records_path(directory)).map_err(issue)?),
        };
        Ok(Records { index: self, reader })
    }
    fn entry_from(&self, n: usize, reader: &mut (impl Read + Seek)) -> Result<Entry> {
        let row = self
            .entries
            .get(n)
            .ok_or_else(|| issue("Unknown source object"))?;
        let bytes = large_json::read_fragment(reader, self.locations[n]).map_err(issue)?;
        let mut entry = decode_stored_entry(&bytes).map_err(issue)?;
        for edit in self.edits.iter().skip(self.generations[n]) {
            for field in &mut entry.fields {
                adjust(&mut field.value, edit.span, edit.length)?;
                adjust(&mut field.member, edit.span, edit.length)?;
            }
        }
        entry.span = row.span;
        entry.member = row.member;
        entry.parent = row.parent;
        entry.depth = row.depth;
        entry.name = row.name.clone();
        Ok(entry)
    }
    pub fn scalar_edit(&mut self, span: Span, bytes: &[u8]) -> Result<()> {
        let length = bytes.len() as u64;
        for entry in &mut self.entries {
            adjust(&mut entry.span, span, length)?;
            adjust(&mut entry.member, span, length)?;
        }
        self.bytes = (self.bytes as i128 + length as i128 - span.len() as i128)
            .try_into()
            .map_err(issue)?;
        self.edits.push(Edit { span, length });
        Ok(())
    }
    pub fn replace_branch(&self, n: usize, bytes: &[u8], directory: &Path) -> Result<Self> {
        let span = self.entries[n].span;
        let local = large_json::index_subtree(bytes, MAX_FRAGMENT_BYTES, self.entries[n].depth)
            .map_err(issue)?;
        let end = self
            .entries
            .iter()
            .enumerate()
            .skip(n)
            .take_while(|(_, e)| e.span.start >= span.start && e.span.end <= span.end)
            .last()
            .map(|(i, _)| i + 1)
            .unwrap_or(n + 1);
        let count_delta = local.entries.len() as i128 - (end - n) as i128;
        let mut result = self.clone();
        for (i, row) in result.entries.iter_mut().enumerate() {
            if (n..end).contains(&i) {
                continue;
            }
            adjust(&mut row.span, span, bytes.len() as u64)?;
            adjust(&mut row.member, span, bytes.len() as u64)?;
            if let Some(parent) = &mut row.parent {
                if *parent >= end {
                    *parent = (*parent as i128 + count_delta).try_into().map_err(issue)?;
                }
            }
        }
        result.bytes = (result.bytes as i128 + bytes.len() as i128 - span.len() as i128)
            .try_into()
            .map_err(issue)?;
        result.edits.push(Edit {
            span,
            length: bytes.len() as u64,
        });
        let generation = result.edits.len();
        let mut rows = Vec::new();
        let mut locations = Vec::new();
        let mut generations = Vec::new();
        let mut file = if let RecordBacking::RecoveryMemory(bytes) = &self.backing {
            // Structural edits still stage records on disk. If publication
            // fails, the candidate's owned directory is removed on drop.
            let temporary = TemporaryIndexDirectory::create(directory)?;
            result.data = "records".into();
            let mut file = OpenOptions::new().create_new(true).append(true)
                .open(temporary.0.join(&result.data)).map_err(save_io)?;
            file.write_all(bytes).map_err(save_io)?;
            result.backing = RecordBacking::Temporary(temporary);
            file
        } else {
            OpenOptions::new().append(true).open(self.records_path(directory)).map_err(issue)?
        };
        let mut at = file.metadata().map_err(issue)?.len();
        for (j, mut e) in local.entries.into_iter().enumerate() {
            e.parent = if j == 0 {
                self.entries[n].parent
            } else {
                e.parent.map(|p| n + p)
            };
            e.span.start += span.start;
            e.span.end += span.start;
            e.member.start += span.start;
            e.member.end += span.start;
            if j == 0 {
                e.member.start = self.entries[n].member.start;
            }
            for field in &mut e.fields {
                field.value.start += span.start;
                field.value.end += span.start;
                field.member.start += span.start;
                field.member.end += span.start;
            }
            let mut raw = Vec::new();
            encode_entry(&e, &mut raw).map_err(issue)?;
            file.write_all(&raw).map_err(issue)?;
            locations.push(Span {
                start: at,
                end: at + raw.len() as u64,
            });
            at += raw.len() as u64;
            rows.push(Row::from_entry(&e));
            generations.push(generation);
        }
        file.sync_all().map_err(issue)?;
        result.entries.splice(n..end, rows);
        result.locations.splice(n..end, locations);
        result.generations.splice(n..end, generations);
        result.refresh_navigation();
        Ok(result)
    }
}
fn adjust(value: &mut Span, span: Span, length: u64) -> Result<()> {
    let delta = length as i128 - span.len() as i128;
    let shift = |n: u64| u64::try_from(n as i128 + delta).map_err(issue);
    if value.end <= span.start {
        return Ok(());
    }
    if value.start >= span.end {
        value.start = shift(value.start)?;
        value.end = shift(value.end)?;
    } else if value.start <= span.start && value.end >= span.end {
        value.end = shift(value.end)?;
    } else {
        return Err(issue(
            "Source anchor intersects a replaced subtree; reload its working index",
        ));
    }
    Ok(())
}


#[cfg(test)]
mod stream_pipeline_tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory { fn new() -> Self {
        static NEXT:AtomicUsize=AtomicUsize::new(0);
        let p=std::env::temp_dir().join(format!("futureox-index-pipeline-{}-{}-{}",std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),NEXT.fetch_add(1,Ordering::Relaxed)));
        fs::create_dir(&p).unwrap();Self(p)
    }}
    impl Drop for Directory {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    #[test]
    fn recovery_records_charge_their_allocation_and_stage_structure_edits_on_disk() {
        let d = Directory::new();
        let source = br#"{"_class":"page","do_objectID":"p","layers":[{"_class":"rectangle","do_objectID":"r","name":"Before"}]}"#;
        let edited = br#"{"_class":"rectangle","do_objectID":"r","name":"After"}"#;
        let mut remaining = 4096;
        let index = DiskIndex::build_in_memory(source.as_slice(), 4096, &mut remaining).unwrap();
        let RecordBacking::RecoveryMemory(bytes) = &index.backing else {
            panic!("the recovery index must have an in-memory record owner");
        };
        assert_eq!(remaining, 4096 - bytes.capacity());
        let mut short = bytes.len() - 1;
        let shortage = DiskIndex::build_in_memory(source.as_slice(), 4096, &mut short).err().unwrap();
        assert_eq!(shortage.code, "SOURCE_STORAGE_FULL");
        assert_eq!(short, bytes.len() - 1);
        assert_eq!(fs::read_dir(&d.0).unwrap().count(), 0);

        let changed = index.replace_branch(1, edited, &d.0).unwrap();
        assert_eq!(index.entry(1, &d.0).unwrap().name, "Before");
        assert_eq!(changed.entry(1, &d.0).unwrap().name, "After");
        let staged_records = changed.records_path(&d.0);
        assert!(staged_records.is_file());
        drop(changed);
        assert!(!staged_records.exists());
    }

    #[test] fn compact_records_keep_identity_fields_and_reject_trailing_bytes() {
        let d=Directory::new();
        let source=json!({"_class":"page","do_objectID":"page","name":"页 🙂","layers":[
            {"_class":"group","do_objectID":"g","name":"组","layers":[
                {"_class":"rectangle","do_objectID":"r","name":"矩形","frame":{"x":1,"y":2,"width":3,"height":4},"rotation":12.5}
            ]}
        ]});
        let bytes=serde_json::to_vec(&source).unwrap();
        let scanned=large_json::index(bytes.as_slice(),1024*1024).unwrap();
        let index=DiskIndex::build(bytes.as_slice(),1024*1024,&d.0).unwrap();
        assert_eq!(index.entries.len(),scanned.entries.len());
        for (i,expected) in scanned.entries.iter().enumerate() {
            let actual=index.entry(i,&d.0).unwrap();
            assert_eq!(serde_json::to_value(&actual).unwrap(),serde_json::to_value(expected).unwrap());
        }
        let mut torn=Vec::new();
        encode_entry(&scanned.entries[0],&mut torn).unwrap();
        torn.push(1);
        assert!(decode_entry(&torn).is_err());
        torn.pop();
        assert_eq!(serde_json::to_value(decode_entry(&torn).unwrap()).unwrap(),serde_json::to_value(&scanned.entries[0]).unwrap());
        let legacy=serde_json::to_vec(&scanned.entries[0]).unwrap();
        assert_eq!(serde_json::to_value(decode_stored_entry(&legacy).unwrap()).unwrap(),serde_json::to_value(&scanned.entries[0]).unwrap());
        let fieldless = large_json::Entry { fields: Vec::new(), ..scanned.entries[0].clone() };
        encode_entry(&fieldless, &mut torn).unwrap();
        let count = torn.len() - 4;
        torn[count..].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_entry(&torn).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
    #[test] fn pipelined_index_matches_records_across_unicode_chunk_boundaries() {
        let d=Directory::new();let bytes=serde_json::to_vec(&json!({"nodes":{"n":{"id":"n","name":"Node","opaque":format!("{}🙂tail","a".repeat(65500)),"children":[]}}})).unwrap();
        let a=DiskIndex::build(bytes.as_slice(),1024*1024,&d.0).unwrap();let b=DiskIndex::build_pipelined(bytes.as_slice(),1024*1024,&d.0).unwrap();
        assert_eq!(a.bytes,b.bytes);assert_eq!(serde_json::to_value(&a.entries).unwrap(),serde_json::to_value(&b.entries).unwrap());
        for i in 0..a.entries.len(){assert_eq!(serde_json::to_value(a.entry(i,&d.0).unwrap()).unwrap(),serde_json::to_value(b.entry(i,&d.0).unwrap()).unwrap());}
    }
    #[test] fn archive_failure_after_valid_json_cannot_publish_an_index() {
        struct TailFailure {remaining:std::io::Cursor<Vec<u8>>}
        impl Read for TailFailure {fn read(&mut self,out:&mut [u8])->io::Result<usize>{let n=self.remaining.read(out)?;if n==0{Err(io::Error::other("injected CRC failure"))}else{Ok(n)}}}
        let d=Directory::new();let error=DiskIndex::build_pipelined(TailFailure{remaining:std::io::Cursor::new(b"{\"nodes\":{}}".to_vec())},1024,&d.0).err().unwrap();
        assert!(error.message.contains("injected CRC failure"));
    }
    #[test] fn malformed_prefix_stops_read_ahead_at_the_bounded_queue() {
        struct Counting {bytes:usize}
        impl Read for Counting {fn read(&mut self,out:&mut [u8])->io::Result<usize>{out.fill(b'x');if self.bytes==0{out[0]=b'!';}self.bytes+=out.len();Ok(out.len())}}
        let d=Directory::new();let mut reader=Counting{bytes:0};assert!(DiskIndex::build_pipelined(&mut reader,16*1024*1024,&d.0).is_err());
        assert!(reader.bytes<=4*STREAM_CHUNK,"read ahead {}",reader.bytes);
    }
}
