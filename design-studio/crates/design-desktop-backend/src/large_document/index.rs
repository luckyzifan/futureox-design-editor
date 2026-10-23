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
    offsets: Vec<u32>,
    children: Vec<u32>,
    roots: Vec<u32>,
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
impl DiskIndex {
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
        let mut offsets = vec![0u32; count + 1];
        let mut roots = Vec::new();
        for (n, row) in self.entries.iter().enumerate() {
            if let Some(parent) = row.parent {
                offsets[parent + 1] += 1;
            } else {
                roots.push(n as u32);
            }
        }
        for i in 1..offsets.len() {
            offsets[i] += offsets[i - 1];
        }
        let mut children = vec![0u32; offsets[count] as usize];
        let mut next = offsets.clone();
        for (n, row) in self.entries.iter().enumerate() {
            if let Some(parent) = row.parent {
                children[next[parent] as usize] = n as u32;
                next[parent] += 1;
            }
        }
        // With the global one-million-row admission, CSR + optional 24-byte
        // lowercase names stay below 64 MiB across all parts. Long names use
        // the original row on demand, so caching never truncates search matches.
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
    pub fn children(&self, parent: Option<usize>) -> &[u32] {
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
        if result.entries.len() > large_json::MAX_INDEX_VALUES {
            return Err(issue("Source object index count exceeded"));
        }
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
