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
    pub bytes: u64,
    pub entries: Vec<Row>,
    locations: Vec<Span>,
    generations: Vec<usize>,
    edits: Vec<Edit>,
    data: String,
}
const STREAM_CHUNK: usize = 64 * 1024;
struct ChunkReader {
    receiver: std::sync::mpsc::Receiver<Vec<u8>>,
    current: std::io::Cursor<Vec<u8>>,
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

impl DiskIndex {
    /// Decode/spool/hash on the caller while one worker parses the same byte
    /// stream. Two queued chunks plus producer/consumer bound staging to256KiB.
    /// Full EOF/CRC and parser success are both required before publication.
    pub fn build_pipelined(mut reader: impl Read, limit: u64, directory: &Path) -> Result<Self> {
        std::thread::scope(|scope| {
            let (sender, receiver) = std::sync::mpsc::sync_channel(2);
            let parser = scope.spawn(move || Self::build(ChunkReader {
                receiver, current: std::io::Cursor::new(Vec::new()),
            }, limit, directory));
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
        let mut writer = BufWriter::new(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(directory.join(&data))
                .map_err(issue)?,
        );
        let mut entries = Vec::new();
        let mut locations = Vec::new();
        let mut at = 0;
        let summary = large_json::scan(reader, limit, |ordinal, entry| {
            if entries.len() <= ordinal {
                entries.resize_with(ordinal + 1, Row::default);
                locations.resize(ordinal + 1, Span::default());
            }
            let bytes = serde_json::to_vec(&entry).map_err(io::Error::other)?;
            writer.write_all(&bytes)?;
            locations[ordinal] = Span {
                start: at,
                end: at + bytes.len() as u64,
            };
            at += bytes.len() as u64;
            entries[ordinal] = Row::from_entry(&entry);
            Ok(())
        })
        .map_err(issue)?;
        writer.flush().map_err(issue)?;
        writer.get_ref().sync_all().map_err(issue)?;
        let mut result = Self {
            navigation: Arc::default(),
            bytes: summary.bytes,
            generations: vec![0; entries.len()],
            entries,
            locations,
            edits: Vec::new(),
            data,
        };
        result.refresh_navigation();
        Ok(result)
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
        let row = self
            .entries
            .get(n)
            .ok_or_else(|| issue("Unknown source object"))?;
        let mut file = File::open(directory.join(&self.data)).map_err(issue)?;
        let bytes = large_json::read_fragment(&mut file, self.locations[n]).map_err(issue)?;
        let mut entry: Entry = serde_json::from_slice(&bytes).map_err(issue)?;
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
        let mut file = OpenOptions::new()
            .append(true)
            .open(directory.join(&self.data))
            .map_err(issue)?;
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
            let raw = serde_json::to_vec(&e).map_err(issue)?;
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
