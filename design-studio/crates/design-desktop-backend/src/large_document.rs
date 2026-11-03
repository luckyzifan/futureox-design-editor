//! File-backed source JSON. Renderer requests carry opaque identities and small
//! fragments; paths are supplied only by the trusted native-dialog host.
use crate::{BackendError, Result};
use futureox_design_kernel::large_json::{
    self, Addition, Changes, MAX_FRAGMENT_BYTES, Span,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

const HISTORY_LIMIT: usize = 32;
const HISTORY_BYTES: usize = 64 * 1024 * 1024;
mod checkpoint_io;
#[cfg(test)]
mod checkpoint_tests;
mod index;
mod capacity;
mod projection;
mod symbol_index;
mod scene;
mod canvas_layout;
mod canvas_snapshot;
mod navigation_image;
mod window_cache;
#[cfg(test)]
#[path = "large_document/fragment_validation_tests.rs"]
mod fragment_validation_tests;
use checkpoint_io::{CheckpointWriter, MAX_CHECKPOINT_BYTES};
use index::DiskIndex;
fn issue(error: impl std::fmt::Display) -> BackendError {
    BackendError::new("LARGE_DOCUMENT_ERROR", error.to_string())
}
fn check_cancel(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(io::Error::new(
            // io::copy retries Interrupted forever. Cooperative cancellation
            // must propagate out of the streaming loop instead of spinning.
            io::ErrorKind::Other,
            "Large document operation cancelled",
        ))
    } else {
        Ok(())
    }
}
struct CheckedReader<'a, R> {
    inner: R,
    cancel: &'a AtomicBool,
    progress: Option<&'a Progress>,
}
impl<R: Read> Read for CheckedReader<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        check_cancel(self.cancel)?;
        let n = self.inner.read(bytes)?;
        if let Some(progress) = self.progress {
            progress.bytes.fetch_add(n as u64, Ordering::Relaxed);
        }
        Ok(n)
    }
}
impl<R: Seek> Seek for CheckedReader<'_, R> {
    fn seek(&mut self, at: SeekFrom) -> io::Result<u64> {
        self.inner.seek(at)
    }
}
/// One-pass source tee. Only bytes actually accepted by the spool writer
/// enter the receipt, and parser/CRC failures cannot publish a source part.
struct IndexedSpool<'a,R,W>{inner:R,output:&'a mut W,hash:&'a mut Sha256,bytes:&'a mut u64}
impl<R:Read,W:Write> Read for IndexedSpool<'_,R,W>{
    fn read(&mut self,bytes:&mut [u8])->io::Result<usize>{
        let n=self.inner.read(bytes)?;
        self.output.write_all(&bytes[..n])?;
        self.hash.update(&bytes[..n]);
        *self.bytes=self.bytes.checked_add(n as u64).ok_or_else(||io::Error::other("Source byte count overflow"))?;
        Ok(n)
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hash_file(path: &Path, cancel: &AtomicBool) -> io::Result<String> {
    hash_range(
        path,
        Span {
            start: 0,
            end: File::open(path)?.metadata()?.len(),
        },
        cancel,
    )
}
fn hash_range(path: &Path, span: Span, cancel: &AtomicBool) -> io::Result<String> {
    let mut source = File::open(path)?;
    source.seek(SeekFrom::Start(span.start))?;
    let mut file = source.take(span.len());
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 64 * 1024];
    loop {
        check_cancel(cancel)?;
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn safe_member(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains(['\\', ':', '\0'])
        && value
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Owner {
    document_id: String,
    session_epoch: u64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Part {
    name: String,
    file: String,
    hash: String,
    base_bytes: u64,
    index: DiskIndex,
    #[serde(default)]
    additions: Vec<Addition>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct State {
    changes: Vec<Changes>,
}
#[derive(Serialize, Deserialize)]
struct Session {
    version: u32,
    owner: Owner,
    name: String,
    format: String,
    source_hash: String,
    revision: u64,
    saved_revision: u64,
    expanded_bytes: u64,
    #[serde(skip)]
    max_expanded_bytes: u64,
    parts: Vec<Part>,
    state: State,
    undo: Vec<State>,
    redo: Vec<State>,
    #[serde(skip)]
    directory: PathBuf,
    #[serde(skip)]
    projection: Option<projection::Projection>,
    #[serde(skip)]
    scene: Option<scene::Scene>,
    #[serde(skip)]
    canvas_layout: Option<canvas_layout::Layout>,
    #[serde(skip)]
    canvas_snapshot: Option<canvas_snapshot::Snapshot>,
    #[serde(skip)]
    converted_windows: Mutex<window_cache::Windows>,
}
#[derive(Default)]
struct Progress {
    meta: Mutex<Option<(Owner, &'static str)>>,
    bytes: AtomicU64,
    total: AtomicU64,
}
struct ProgressGuard<'a>(&'a Progress);
impl Drop for ProgressGuard<'_> {
    fn drop(&mut self) {
        self.0.phase("idle", 0);
    }
}
impl Progress {
    fn begin(&self, owner: Owner, phase: &'static str) -> ProgressGuard<'_> {
        *self.meta.lock().unwrap() = Some((owner, phase));
        self.bytes.store(0, Ordering::Relaxed);
        self.total.store(0, Ordering::Relaxed);
        ProgressGuard(self)
    }
    fn phase(&self, phase: &'static str, total: u64) {
        let mut meta = self.meta.lock().unwrap();
        self.bytes.store(0, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
        if let Some(meta) = meta.as_mut() {
            meta.1 = phase;
        }
    }
    fn read(&self, owner: &Owner) -> Result<Value> {
        let meta = self.meta.lock().map_err(issue)?;
        let (active, phase) = meta
            .as_ref()
            .filter(|(id, _)| id == owner)
            .ok_or_else(|| issue("No owned large document progress"))?;
        Ok(
            json!({"owner":active,"phase":phase,"processedBytes":self.bytes.load(Ordering::Relaxed),"totalBytes":self.total.load(Ordering::Relaxed)}),
        )
    }
}
struct Fragment {
    owner: Owner,
    revision: u64,
    key: String,
    text: String,
    omitted: Vec<String>,
    bytes: usize,
}
#[derive(Default)]
struct Fragments {
    items: VecDeque<Fragment>,
    bytes: usize,
}
impl Fragments {
    fn read(
        &mut self,
        session: &Session,
        key: &str,
        part: usize,
        node: usize,
    ) -> Result<(String, Vec<String>)> {
        if let Some(n) = self.items.iter().position(|f| {
            f.owner == session.owner && f.revision == session.revision && f.key == key
        }) {
            let item = self.items.remove(n).unwrap();
            let result = (item.text.clone(), item.omitted.clone());
            self.items.push_front(item);
            return Ok(result);
        }
        let (text, omitted) = properties(session, part, node)?;
        let bytes = text.len() + omitted.iter().map(String::len).sum::<usize>() + key.len() + 256;
        while self.bytes + bytes > 8 * 1024 * 1024 || self.items.len() >= 16 {
            let Some(old) = self.items.pop_back() else {
                break;
            };
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
        self.items.push_front(Fragment {
            owner: session.owner.clone(),
            revision: session.revision,
            key: key.into(),
            text: text.clone(),
            omitted: omitted.clone(),
            bytes,
        });
        Ok((text, omitted))
    }
}
pub(crate) struct Sessions {
    root: PathBuf,
    current: Mutex<Option<Session>>,
    progress: Progress,
    fragments: Mutex<Fragments>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Open {
    path: PathBuf,
    document_id: String,
    session_epoch: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    #[serde(default)]
    navigation_preview: bool,
    owner: Owner,
    expected_revision: u64,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    canvas_only: bool,
    #[serde(default)]
    json: Option<String>,
    #[serde(default)]
    expected_hash: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    path: Option<PathBuf>,
    #[serde(default)]
    working_document_id: Option<String>,
}
impl Sessions {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            current: Mutex::new(None),
            progress: Progress::default(),
            fragments: Mutex::new(Fragments::default()),
        }
    }
    pub(crate) fn open(&self, request: Open, cancel: &AtomicBool) -> Result<Value> {
        let mut slot = self.current.lock().map_err(issue)?;
        if slot.is_some() {
            return Err(issue(
                "Close the current large document before opening another",
            ));
        }
        if !identity(&request.document_id)
            || request.session_epoch == 0
            || request.session_epoch > 9_007_199_254_740_991
            || !request.path.is_absolute()
        {
            return Err(issue("Invalid large document identity/path"));
        }
        let _progress = self.progress.begin(
            Owner {
                document_id: request.document_id.clone(),
                session_epoch: request.session_epoch,
            },
            "validate",
        );
        let before = fs::symlink_metadata(&request.path).map_err(issue)?;
        fs::create_dir_all(&self.root).map_err(issue)?;
        let source_limit = capacity::source_limit(&self.root)?;
        if !before.is_file() || before.len() > source_limit {
            return Err(issue("Source exceeds the backing storage capacity or is not a regular file"));
        }
        capacity::require_space(&self.root, before.len())?;
        let extension = request
            .path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["json", "sketch"].contains(&extension.as_str()) {
            return Err(issue("Choose a .json or .sketch source"));
        }
        fs::create_dir_all(&self.root).map_err(issue)?;
        let directory = self
            .root
            .join(format!("{}-{}", request.document_id, request.session_epoch));
        fs::create_dir(&directory).map_err(issue)?;
        let result = (|| -> Result<Session> {
            self.progress.phase("copy", before.len());
            let original = directory.join("source");
            let mut source = CheckedReader {
                inner: File::open(&request.path).map_err(issue)?,
                cancel,
                progress: Some(&self.progress),
            };
            let mut destination = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&original)
                .map_err(issue)?;
            let copied = io::copy(
                &mut source.by_ref().take(source_limit + 1),
                &mut destination,
            )
            .map_err(issue)?;
            if copied != before.len() {
                return Err(issue("Source changed or exceeded storage capacity while reading"));
            }
            destination.sync_all().map_err(issue)?;
            let after = source.inner.metadata().map_err(issue)?;
            if after.len() != before.len() || after.modified().ok() != before.modified().ok() {
                return Err(issue("Source changed during import"));
            }
            self.progress.phase("validate", 0);
            let source_hash = hash_file(&original, cancel).map_err(issue)?;
            if let Some(mut recovered) = recover(&self.root, &directory, &source_hash, source_limit, cancel)? {
                recovered.owner = Owner {
                    document_id: request.document_id.clone(),
                    session_epoch: request.session_epoch,
                };
                let _ = fs::remove_dir_all(&directory);
                return Ok(recovered);
            }
            let mut parts = Vec::new();
            let mut expanded_bytes = 0;
            if extension == "json" {
                self.progress.phase("index", before.len());
                let reader = CheckedReader {
                    inner: File::open(&original).map_err(issue)?,
                    cancel,
                    progress: Some(&self.progress),
                };
                let index = DiskIndex::build(reader, source_limit, &directory)?;
                expanded_bytes = index.bytes;
                parts.push(Part {
                    name: "document.json".into(),
                    file: "source".into(),
                    hash: source_hash.clone(),
                    base_bytes: index.bytes,
                    index,
                    additions: Vec::new(),
                });
            } else {
                let mut archive =
                    zip::ZipArchive::new(File::open(&original).map_err(issue)?).map_err(issue)?;
                validate_directory(&original, archive.central_directory_start(), archive.len())
                    .map_err(issue)?;
                let mut names = HashSet::new();
                for i in 0..archive.len() {
                    check_cancel(cancel).map_err(issue)?;
                    let mut entry = archive.by_index(i).map_err(issue)?;
                    let name = entry.name().trim_end_matches('/').to_owned();
                    if !safe_member(&name)
                        || !names.insert(name.clone())
                        || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
                    {
                        return Err(issue("Unsafe or duplicate Sketch archive member"));
                    }
                    if entry.is_dir() {
                        continue;
                    }
                    if entry.size() > source_limit.saturating_sub(expanded_bytes) {
                        return Err(issue("Sketch expanded data exceeds backing storage capacity"));
                    }
                    let declared = entry.size();
                    self.progress.phase("expand", declared);
                    if name.ends_with(".json") {
                        capacity::require_space(&directory, declared)?;
                        let file = format!("part-{}", parts.len());
                        let mut target = BufWriter::new(File::create(directory.join(&file)).map_err(issue)?);
                        let mut hash=Sha256::new();let mut copied=0u64;
                        let reader=CheckedReader{inner:&mut entry,cancel,progress:Some(&self.progress)};
                        self.progress.phase("index",declared);
                        // The parser, immutable spool and receipt consume the
                        // same decompressed stream. CRC/EOF and fsync remain
                        // required; no full reread for hashing and indexing.
                        let stream=IndexedSpool{
                            inner:reader.take(declared+1),output:&mut target,hash:&mut hash,bytes:&mut copied,
                        };
                        let index=if declared>=1024*1024 {
                            DiskIndex::build_pipelined(stream,source_limit-expanded_bytes,&directory)?
                        } else {DiskIndex::build(stream,source_limit-expanded_bytes,&directory)?};
                        if copied!=declared||index.bytes!=declared{return Err(issue("Sketch member length changed"));}
                        target.flush().map_err(issue)?;
                        target.get_ref().sync_all().map_err(issue)?;
                        let hash=format!("{:x}",hash.finalize());
                        parts.push(Part {
                            name,
                            file,
                            hash,
                            base_bytes: index.bytes,
                            index,
                            additions: Vec::new(),
                        });
                    } else {
                        // Validate real decompression and CRC without retaining assets.
                        let mut reader = CheckedReader {
                            inner: &mut entry,
                            cancel,
                            progress: Some(&self.progress),
                        };
                        if io::copy(&mut reader.by_ref().take(declared + 1), &mut io::sink())
                            .map_err(issue)?
                            != declared
                        {
                            return Err(issue("Sketch asset length mismatch"));
                        }
                    }
                    expanded_bytes += declared;
                }
                if !names.contains("document.json") || !names.contains("meta.json") {
                    return Err(issue("Sketch archive has no document/meta"));
                }
            }
            Ok(Session {
                version: 1,
                owner: Owner {
                    document_id: request.document_id,
                    session_epoch: request.session_epoch,
                },
                name: request
                    .path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or("JSON")
                    .into(),
                format: extension,
                source_hash,
                revision: 0,
                saved_revision: 0,
                expanded_bytes,
                max_expanded_bytes: source_limit,
                state: State {
                    changes: vec![Changes::default(); parts.len()],
                },
                parts,
                undo: Vec::new(),
                redo: Vec::new(),
                directory: directory.clone(),
                projection: None,
                scene: None,
                canvas_layout: None,
                canvas_snapshot: None,
                converted_windows: Mutex::default(),
            })
        })();
        match result {
            Ok(session) => {
                persist(&session)?;
                let value = status(&session);
                *slot = Some(session);
                Ok(value)
            }
            Err(error) => {
                let _ = fs::remove_dir_all(&directory);
                Err(error)
            }
        }
    }
    pub(crate) fn dispatch(
        &self,
        method: &str,
        request: Request,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        if method == "large.progress" {
            return self.progress.read(&request.owner);
        }
        if method == "large.export" {
            return self.export_snapshot(request, cancel);
        }
        let mut slot = if matches!(method, "large.status" | "large.children" | "large.read" | "large.canvasLayout") {
            self.current.try_lock().map_err(|_| {
                BackendError::new(
                    "BUSY",
                    "Large source mutation is in progress; retry this read",
                )
            })?
        } else {
            self.current.lock().map_err(issue)?
        };
        let s = slot
            .as_mut()
            .ok_or_else(|| issue("No large document is open"))?;
        if s.owner != request.owner
            || method != "large.status" && s.revision != request.expected_revision
        {
            return Err(issue("Stale or foreign large document revision"));
        }
        check_cancel(cancel).map_err(issue)?;
        match method {
            "large.status" => Ok(status(s)),
            "large.children" => children(s, request),
            "large.canvasLayout" => canvas_layout::list(s, request, cancel),
            "large.canvasSnapshot" => canvas_snapshot::prepare(s,cancel,request.navigation_preview),
            "large.canvasPreview" => Ok(s.canvas_snapshot.as_ref().filter(|snapshot|snapshot.revision==s.revision)
                .and_then(|snapshot|snapshot.navigation.as_ref()).map(|preview|preview.poll()).unwrap_or_else(||json!({"phase":"unavailable"}))),
            "large.read" => {
                let (part, node) = location(s, request.key.as_deref())?;
                let (text, omitted) = self.fragments.lock().map_err(issue)?.read(
                    s,
                    request.key.as_deref().unwrap(),
                    part,
                    node,
                )?;
                Ok(
                    json!({"owner":s.owner,"revision":s.revision,"key":request.key,"json":text,"hash":digest(text.as_bytes()),"omittedFields":omitted}),
                )
            }
            "large.apply" => apply(s, request, cancel),
            "large.project" => projection::project(s, request),
            "large.scene" => scene::load(s, request, cancel),
            "large.sceneRead" => scene::read(s, request),
            "large.sceneCommit" => scene::commit_nodes(s, request, cancel),
            "large.commitCanvas" => projection::commit_canvas(s, request, cancel),
            "large.undo" | "large.redo" => {
                let next = if method == "large.undo" {
                    s.undo.last()
                } else {
                    s.redo.last()
                }
                .cloned()
                .ok_or_else(|| issue("No large document history entry"))?;
                let mut indices = Vec::new();
                for p in 0..s.parts.len() {
                    indices.push(rebuild_index(s, p, &next.changes[p], cancel)?);
                }
                let mut undo = s.undo.clone();
                let mut redo = s.redo.clone();
                if method == "large.undo" {
                    undo.pop();
                    redo.push(s.state.clone());
                } else {
                    redo.pop();
                    undo.push(s.state.clone());
                }
                let value = commit(s, next, undo, redo, None, cancel)?;
                for (part, index) in s.parts.iter_mut().zip(indices) {
                    part.index = index;
                }
                Ok(value)
            }

            "large.close" => {
                let result = status(s);
                *slot = None;
                Ok(result)
            }
            _ => Err(issue("Unknown large document method")),
        }
    }
}
fn status(s: &Session) -> Value {
    let json_bytes: u64 = s.parts.iter().map(|p| p.base_bytes).sum();
    let changed: u64 = s
        .parts
        .iter()
        .enumerate()
        .map(|(p, part)| {
            s.state.changes[p]
                .output_bytes(part.base_bytes)
                .unwrap_or(s.max_expanded_bytes)
        })
        .sum();
    json!({"owner":s.owner,"revision":s.revision,"name":s.name,"format":s.format,"expandedBytes":s.expanded_bytes-json_bytes+changed,"maxExpandedBytes":s.max_expanded_bytes,"indexedObjects":s.parts.iter().map(|p| p.index.entries.len()).sum::<usize>(),"dirty":s.revision!=s.saved_revision,"undoCount":s.undo.len(),"redoCount":s.redo.len()})
}
fn location(s: &Session, key: Option<&str>) -> Result<(usize, usize)> {
    let (part, node) = key
        .and_then(|key| key.split_once(':'))
        .ok_or_else(|| issue("Missing JSON object key"))?;
    let part: usize = part.parse().map_err(issue)?;
    let node: usize = node.parse().map_err(issue)?;
    if s.parts
        .get(part)
        .and_then(|p| p.index.entries.get(node))
        .is_none()
    {
        return Err(issue("Unknown JSON object key"));
    }
    Ok((part, node))
}
fn children(s: &Session, request: Request) -> Result<Value> {
    if request.query.as_ref().is_some_and(|q| q.len() > 1024) {
        return Err(issue("Search query exceeds limit"));
    }
    let query = request
        .query
        .as_ref()
        .filter(|q| !q.is_empty())
        .map(|q| q.to_lowercase());
    let parent = request
        .key
        .as_deref()
        .map(|key| location(s, Some(key)))
        .transpose()?;
    // The canvas browser lists authored pages/layers, not JSON metadata. Apply
    // its scope BEFORE counting/pagination so metadata cannot consume a page.
    // Generic JSON inspection keeps the existing complete catalog.
    let canvas_only = request.canvas_only && s.format == "sketch";
    let layer_span = if canvas_only {
        parent.map(|(p, n)| s.parts[p].index.entry(n, &s.directory)
            .map(|entry| entry.fields.into_iter().find(|f| f.key == "layers").map(|f| f.value)))
            .transpose()?.flatten()
    } else { None };
    let limit = request.limit.unwrap_or(100).clamp(1, 200);
    let mut found = Vec::new();
    let mut total = 0;
    for (p, part) in s.parts.iter().enumerate() {
        let candidates: Box<dyn Iterator<Item = usize> + '_> = if query.is_some() && !canvas_only {
            Box::new(0..part.index.entries.len())
        } else {
            if parent.is_some_and(|(part_id, _)| part_id != p) {
                continue;
            }
            Box::new(
                part.index
                    .children(parent.map(|(_, n)| n))
                    .iter()
                    .map(|n| *n as usize),
            )
        };
        for n in candidates {
            let entry = &part.index.entries[n];
            if canvas_only {
                if parent.is_none() {
                    if entry.kind != "page" || !part.name.starts_with("pages/") { continue; }
                } else if !layer_span.is_some_and(|span| entry.span.start >= span.start && entry.span.end <= span.end) {
                    continue;
                }
            }
            if query
                .as_ref()
                .is_some_and(|query| !part.index.name_matches(n, query) && !entry.id.eq_ignore_ascii_case(query))
            {
                continue;
            }
            if total >= request.offset && found.len() < limit {
                found.push(json!({"key":format!("{p}:{n}"),"id":entry.id,"name":entry.name,"kind":entry.kind,"bytes":entry.span.len(),"part":part.name,"hasChildren":part.index.has_children(n)}));
            }
            total += 1;
        }
    }
    Ok(
        json!({"owner":s.owner,"revision":s.revision,"items":found,"total":total,"offset":request.offset,"hasMore":request.offset.saturating_add(found.len())<total}),
    )
}
fn properties(s: &Session, p: usize, n: usize) -> Result<(String, Vec<String>)> {
    let part = &s.parts[p];
    let entry = part.index.entry(n, &s.directory)?;
    let mut file = File::open(s.directory.join(&part.file)).map_err(issue)?;
    let mut text = String::from("{");
    let mut omitted = Vec::new();
    let children: Vec<Span> = part
        .index
        .children(Some(n))
        .iter()
        .map(|child| part.index.entries[*child as usize].span)
        .collect();
    for field in &entry.fields {
        let encoded_key = serde_json::to_string(&field.key).map_err(issue)?;
        if matches!(field.key.as_str(), "layers" | "nodes")
            || field.value.len() > MAX_FRAGMENT_BYTES / 2
            || (text.len() + encoded_key.len() + 4) as u64 + field.value.len()
                > MAX_FRAGMENT_BYTES / 2
            || children
                .iter()
                .any(|child| child.start >= field.value.start && child.end <= field.value.end)
        {
            if omitted.len() < 128 {
                omitted.push(field.key.chars().take(128).collect());
            }
            continue;
        }
        let bytes = s.state.changes[p]
            .fragment(&mut file, field.value, part.base_bytes)
            .map_err(issue)?;
        if text.len() > 1 {
            text.push(',');
        }
        text.push('\n');
        text.push_str(&encoded_key);
        text.push(':');
        text.push_str(std::str::from_utf8(&bytes).map_err(issue)?);
    }
    text.push_str("\n}");
    Ok((text, omitted))
}
fn apply(s: &mut Session, request: Request, cancel: &AtomicBool) -> Result<Value> {
    let (p, n) = location(s, request.key.as_deref())?;
    let (before, _) = properties(s, p, n)?;
    if request.expected_hash.as_deref() != Some(digest(before.as_bytes()).as_str()) {
        return Err(issue("JSON fragment changed; reload it before editing"));
    }
    if !request.request_id.as_deref().is_some_and(identity) {
        return Err(issue("Invalid JSON edit request identity"));
    }
    let text = request
        .json
        .as_deref()
        .ok_or_else(|| issue("Missing JSON edit"))?;
    if text.len() as u64 > MAX_FRAGMENT_BYTES / 2 {
        return Err(issue("JSON edit fragment exceeds 2 MiB"));
    }
    let old: BTreeMap<String, Box<RawValue>> = serde_json::from_str(&before).map_err(issue)?;
    // Check every object before serde's map conversion can collapse duplicate
    // keys, even when that object is not selected for source navigation.
    large_json::validate_fragment(text.as_bytes()).map_err(issue)?;
    let new: BTreeMap<String, Box<RawValue>> = serde_json::from_str(text).map_err(issue)?;
    if old.keys().ne(new.keys()) {
        return Err(issue(
            "Edit existing properties here; select children separately",
        ));
    }
    let mut next = s.state.clone();
    let mut edits = Vec::new();
    for (key, value) in &new {
        if old[key].get() == value.get() {
            continue;
        }
        if matches!(key.as_str(), "id" | "do_objectID" | "_class") {
            return Err(issue(
                "JSON object identity/class cannot change in a property edit",
            ));
        }
        let record = s.parts[p].index.entry(n, &s.directory)?;
        let span = record.fields.iter().find(|f| &f.key == key).unwrap().value;
        edits.push((span, value.get().as_bytes().to_vec()));
    }
    if edits.is_empty() {
        return Ok(status(s));
    }
    edits.sort_by_key(|(span, _)| std::cmp::Reverse(span.start));
    for (span, value) in &edits {
        next.changes[p]
            .replace(*span, value.clone(), s.parts[p].base_bytes)
            .map_err(issue)?;
    }
    let mut index = adjusted_index(s, p, &next.changes[p], &edits, cancel)?;
    if let Some(name) = new
        .get("name")
        .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
    {
        index.entries[n].name = name.chars().take(160).collect();
    }
    index.refresh_navigation();
    let mut undo = s.undo.clone();
    undo.push(s.state.clone());
    while undo.len() > HISTORY_LIMIT
        || undo
            .iter()
            .flat_map(|s| &s.changes)
            .map(Changes::retained_bytes)
            .sum::<usize>()
            > HISTORY_BYTES
    {
        undo.remove(0);
    }
    commit(s, next, undo, Vec::new(), Some((p, index)), cancel)
}
fn adjusted_index(
    s: &Session,
    p: usize,
    changes: &Changes,
    edits: &[(Span, Vec<u8>)],
    cancel: &AtomicBool,
) -> Result<DiskIndex> {
    let old = &s.parts[p].index;
    let root = old.entry(0, &s.directory)?;
    let introduces_root_children = edits.iter().any(|(span, bytes)| {
        root.fields.iter().any(|field| field.value == *span)
            && matches!(bytes.first(), Some(b'{') | Some(b'['))
    });
    if introduces_root_children {
        return rebuild_index(s, p, changes, cancel);
    }
    if edits.iter().any(|(span, _)| {
        old.entries
            .iter()
            .any(|e| e.span.start >= span.start && e.span.end <= span.end)
    }) {
        return rebuild_index(s, p, changes, cancel);
    }
    let mut index = old.clone();
    for (span, bytes) in edits {
        index.scalar_edit(*span, bytes)?
    }
    Ok(index)
}
fn rebuild_index(
    s: &Session,
    p: usize,
    changes: &Changes,
    cancel: &AtomicBool,
) -> Result<DiskIndex> {
    let mut file = CheckedReader {
        inner: File::open(s.directory.join(&s.parts[p].file)).map_err(issue)?,
        cancel,
        progress: None,
    };
    let reader = changes
        .reader(&mut file, s.parts[p].base_bytes)
        .map_err(issue)?;
    DiskIndex::build(reader, s.max_expanded_bytes, &s.directory)
}

fn commit(
    s: &mut Session,
    mut next: State,
    undo: Vec<State>,
    redo: Vec<State>,
    index: Option<(usize, DiskIndex)>,
    cancel: &AtomicBool,
) -> Result<Value> {
    let source_json: u64 = s.parts.iter().map(|p| p.base_bytes).sum();
    let current_json = s
        .parts
        .iter()
        .enumerate()
        .try_fold(0u64, |sum, (p, part)| {
            next.changes[p]
                .output_bytes(part.base_bytes)
                .map(|n| sum + n)
        })
        .map_err(issue)?;
    if current_json > s.max_expanded_bytes.saturating_sub(s.expanded_bytes - source_json) {
        return Err(issue(
            "Total expanded JSON/assets exceed backing storage capacity after edit",
        ));
    }
    check_cancel(cancel).map_err(issue)?;
    let mut written = Vec::new();
    for (p, changes) in next.changes.iter_mut().enumerate() {
        let file_path = s.directory.join(&s.parts[p].file);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(file_path)
            .map_err(issue)?;
        let start = file.metadata().map_err(issue)?.len();
        let additions = changes.spill_to(&mut file).map_err(issue)?;
        if !additions.is_empty() {
            file.sync_all().map_err(issue)?;
            written.push((p, start, additions));
        }
    }
    if let Err(error) = check_cancel(cancel) {
        for (p, start, _) in &written {
            let _ = OpenOptions::new()
                .write(true)
                .open(s.directory.join(&s.parts[*p].file))
                .and_then(|f| f.set_len(*start));
        }
        return Err(issue(error));
    }
    for (p, _, additions) in &written {
        s.parts[*p].additions.extend(additions.iter().cloned());
    }
    let previous = std::mem::replace(&mut s.state, next);
    let old_undo = std::mem::replace(&mut s.undo, undo);
    let old_redo = std::mem::replace(&mut s.redo, redo);
    s.revision += 1;
    let result = persist(s);
    if let Err(error) = result {
        s.state = previous;
        s.undo = old_undo;
        s.redo = old_redo;
        s.revision -= 1;
        for (p, start, additions) in &written {
            let retained = s.parts[*p].additions.len() - additions.len();
            s.parts[*p].additions.truncate(retained);
            let _ = OpenOptions::new()
                .write(true)
                .open(s.directory.join(&s.parts[*p].file))
                .and_then(|f| f.set_len(*start));
        }
        return Err(error);
    }
    if let Some(snapshot) = s.canvas_snapshot.as_mut() {
        // Only a successfully persisted revision invalidates this job. The
        // store itself remains available until its successor is published.
        snapshot.navigation.take();
    }
    if let Some((p, index)) = index {
        s.parts[p].index = index;
    }
    let mut value = status(s);
    if let Some(warning) = result.unwrap() {
        value["saveWarning"] = json!(warning);
    }
    Ok(value)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint<'a> {
    version: u32,
    owner: &'a Owner,
    name: &'a str,
    format: &'a str,
    source_hash: &'a str,
    revision: u64,
    saved_revision: u64,
    expanded_bytes: u64,
    state: &'a State,
    undo: &'a [State],
    redo: &'a [State],
    additions: Vec<&'a [Addition]>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryCheckpoint {
    version: u32,
    owner: Owner,
    name: String,
    format: String,
    source_hash: String,
    revision: u64,
    saved_revision: u64,
    expanded_bytes: u64,
    state: State,
    undo: Vec<State>,
    redo: Vec<State>,
    additions: Vec<Vec<Addition>>,
}
fn recover(
    root: &Path,
    new_directory: &Path,
    source_hash: &str,
    source_limit: u64,
    cancel: &AtomicBool,
) -> Result<Option<Session>> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root).map_err(issue)? {
        let entry = entry.map_err(issue)?;
        if entry.path() == new_directory || !entry.file_type().map_err(issue)?.is_dir() {
            continue;
        }
        let path = entry.path().join("journal.json");
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.is_file() && metadata.len() <= MAX_CHECKPOINT_BYTES {
                candidates.push((metadata.modified().ok(), entry.path()));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, directory) in candidates {
        check_cancel(cancel).map_err(issue)?;
        let checkpoint: RecoveryCheckpoint = match serde_json::from_reader(
            File::open(directory.join("journal.json")).map_err(issue)?,
        ) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if checkpoint.source_hash != source_hash {
            continue;
        }
        if checkpoint.version != 1
            || checkpoint.expanded_bytes > source_limit
            || !identity(&checkpoint.owner.document_id)
            || !matches!(checkpoint.format.as_str(), "json" | "sketch")
            || checkpoint.undo.len() > HISTORY_LIMIT
            || checkpoint.redo.len() > HISTORY_LIMIT
        {
            return Err(issue("Retained large document checkpoint is invalid"));
        }
        let index_path = directory.join("index.json");
        let metadata = fs::symlink_metadata(&index_path).map_err(issue)?;
        if !metadata.is_file() || metadata.len() > source_limit {
            return Err(issue("Retained source index is invalid"));
        }
        let mut parts: Vec<Part> =
            serde_json::from_reader(BufReader::new(File::open(index_path).map_err(issue)?))
                .map_err(issue)?;
        if parts.len() != checkpoint.state.changes.len()
            || parts.len() != checkpoint.additions.len()
        {
            return Err(issue("Retained JSON part count mismatch"));
        }
        if checkpoint
            .undo
            .iter()
            .chain(&checkpoint.redo)
            .any(|state| state.changes.len() != parts.len())
        {
            return Err(issue("Retained history part count mismatch"));
        }
        let source_json = parts.iter().try_fold(0u64, |bytes, part| bytes.checked_add(part.base_bytes))
            .filter(|bytes| *bytes <= checkpoint.expanded_bytes)
            .ok_or_else(|| issue("Retained source byte totals are invalid"))?;
        let current_json = parts.iter().enumerate().try_fold(0u64, |bytes, (p, part)| {
            checkpoint.state.changes[p].output_bytes(part.base_bytes).ok().and_then(|size| bytes.checked_add(size))
        }).filter(|bytes| *bytes <= source_limit.saturating_sub(checkpoint.expanded_bytes - source_json))
            .ok_or_else(|| issue("Retained source changes exceed backing storage capacity"))?;
        let _ = current_json;
        let original = directory.join("source");
        if !fs::symlink_metadata(&original).map_err(issue)?.is_file() {
            return Err(issue("Retained original source is invalid"));
        }
        let original_bytes = if checkpoint.format == "json" {
            parts
                .first()
                .ok_or_else(|| issue("Retained JSON has no source part"))?
                .base_bytes
        } else {
            fs::metadata(&original).map_err(issue)?.len()
        };
        if hash_range(
            &original,
            Span {
                start: 0,
                end: original_bytes,
            },
            cancel,
        )
        .map_err(issue)?
            != checkpoint.source_hash
        {
            return Err(issue("Retained original source integrity check failed"));
        }
        let mut names = HashSet::new();
        for (p, part) in parts.iter_mut().enumerate() {
            if !safe_member(&part.name) || !names.insert(part.name.clone()) {
                return Err(issue("Retained source member identity is invalid"));
            }
            if part.file != "source"
                && !(part.file.starts_with("part-")
                    && part.file[5..].bytes().all(|b| b.is_ascii_digit()))
            {
                return Err(issue("Retained source part path is invalid"));
            }
            part.additions = checkpoint.additions[p].clone();
            let file = directory.join(&part.file);
            if !fs::symlink_metadata(&file).map_err(issue)?.is_file()
                || part.base_bytes > source_limit
                || hash_range(
                    &file,
                    Span {
                        start: 0,
                        end: part.base_bytes,
                    },
                    cancel,
                )
                .map_err(issue)?
                    != part.hash
            {
                return Err(issue("Retained source part integrity check failed"));
            }
            for addition in &part.additions {
                if addition.span.end < addition.span.start
                    || hash_range(&file, addition.span, cancel).map_err(issue)? != addition.sha256
                {
                    return Err(issue("Retained JSON addition integrity check failed"));
                }
            }
            let mut reader = CheckedReader {
                inner: File::open(file).map_err(issue)?,
                cancel,
                progress: None,
            };
            part.index = DiskIndex::build(
                checkpoint.state.changes[p]
                    .reader(&mut reader, part.base_bytes)
                    .map_err(issue)?,
                source_limit,
                &directory,
            )?;
        }
        return Ok(Some(Session {
            version: 1,
            owner: checkpoint.owner,
            name: checkpoint.name,
            format: checkpoint.format,
            source_hash: checkpoint.source_hash,
            revision: checkpoint.revision,
            saved_revision: checkpoint.saved_revision,
            expanded_bytes: checkpoint.expanded_bytes,
            max_expanded_bytes: source_limit,
            parts,
            state: checkpoint.state,
            undo: checkpoint.undo,
            redo: checkpoint.redo,
            directory,
            projection: None,
                scene: None,
            canvas_layout: None,
                canvas_snapshot: None,
                converted_windows: Mutex::default(),
        }));
    }
    Ok(None)
}
fn persist(s: &Session) -> Result<Option<&'static str>> {
    let metadata = Checkpoint {
        version: s.version,
        owner: &s.owner,
        name: &s.name,
        format: &s.format,
        source_hash: &s.source_hash,
        revision: s.revision,
        saved_revision: s.saved_revision,
        expanded_bytes: s.expanded_bytes,
        state: &s.state,
        undo: &s.undo,
        redo: &s.redo,
        additions: s.parts.iter().map(|p| p.additions.as_slice()).collect(),
    };
    // Reject oversize metadata before creating index.json or touching journal.next.
    // commit() may already have spilled source additions; its existing rollback
    // remains responsible for those. This is not a no-append transaction plan.
    serde_json::to_writer(&mut CheckpointWriter::new(io::sink()), &metadata).map_err(issue)?;
    // Indexes are immutable and written once, rather than serialized on edits.
    let index_path = s.directory.join("index.json");
    if !index_path.exists() {
        let mut out = BufWriter::new(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&index_path)
                .map_err(issue)?,
        );
        serde_json::to_writer(&mut out, &s.parts).map_err(issue)?;
        out.flush().map_err(issue)?;
        out.get_ref().sync_all().map_err(issue)?;
    }
    let temporary = s.directory.join("journal.next");
    let final_path = s.directory.join("journal.json");
    let mut file = CheckpointWriter::new(BufWriter::new(
        File::create(&temporary).map_err(issue)?,
    ));
    serde_json::to_writer(&mut file, &metadata).map_err(issue)?;
    file.flush().map_err(issue)?;
    file.get_ref().get_ref().sync_all().map_err(issue)?;
    fs::rename(temporary, final_path).map_err(issue)?;
    // Rename is the commit point. Directory-sync failure remains a committed
    // warning, not an error that could roll the already-published state back.
    Ok(File::open(&s.directory)
        .and_then(|f| f.sync_all())
        .err()
        .map(|_| "Local checkpoint published; directory synchronization was not confirmed"))
}

fn validate_directory(path: &Path, start: u64, count: usize) -> io::Result<()> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut records = 0usize;
    loop {
        let mut signature = [0u8; 4];
        file.read_exact(&mut signature)?;
        if signature == *b"PK\x05\x06" || signature == *b"PK\x06\x06" {
            break;
        }
        if signature != *b"PK\x01\x02" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unsupported ZIP directory record",
            ));
        }
        let mut header = [0u8; 42];
        file.read_exact(&mut header)?;
        let size = |offset| u16::from_le_bytes([header[offset], header[offset + 1]]) as i64;
        file.seek(SeekFrom::Current(size(24) + size(26) + size(28)))?;
        records = records.checked_add(1).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "ZIP record address overflow"))?;
        if records > count {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Ambiguous ZIP directory identity",
            ));
        }
    }
    if records != count {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Ambiguous ZIP directory identity",
        ));
    }
    Ok(())
}
struct ExportPart {
    name: String,
    file: String,
    hash: String,
    base_bytes: u64,
    additions: Vec<Addition>,
}
struct ExportSnapshot {
    owner: Owner,
    revision: u64,
    format: String,
    source_hash: String,
    directory: PathBuf,
    parts: Vec<ExportPart>,
    state: State,
    status: Value,
}
impl Sessions {
    fn export_snapshot(&self, request: Request, cancel: &AtomicBool) -> Result<Value> {
        let snapshot = {
            let guard = self.current.lock().map_err(issue)?;
            let s = guard
                .as_ref()
                .ok_or_else(|| issue("No large document is open"))?;
            if s.owner != request.owner || s.revision != request.expected_revision {
                return Err(issue("Stale or foreign large document revision"));
            }
            ExportSnapshot {
                owner: s.owner.clone(),
                revision: s.revision,
                format: s.format.clone(),
                source_hash: s.source_hash.clone(),
                directory: s.directory.clone(),
                parts: s
                    .parts
                    .iter()
                    .map(|p| ExportPart {
                        name: p.name.clone(),
                        file: p.file.clone(),
                        hash: p.hash.clone(),
                        base_bytes: p.base_bytes,
                        additions: p.additions.clone(),
                    })
                    .collect(),
                state: s.state.clone(),
                status: status(s),
            }
        };
        let _progress = self.progress.begin(snapshot.owner.clone(), "validate");
        let warning = write_export(&snapshot, request, cancel, &self.progress)?;
        let mut guard = self.current.lock().map_err(issue)?;
        let mut output = snapshot.status;
        output["dirty"] = json!(false);
        let mut checkpoint_warning = None;
        if let Some(s) = guard.as_mut().filter(|s| s.owner == snapshot.owner) {
            s.saved_revision = snapshot.revision;
            checkpoint_warning = match persist(s) {
                Ok(w) => w,
                Err(_) => {
                    Some("Export was published, but the local session checkpoint was not updated")
                }
            };
            output = status(s);
        }
        Ok(
            json!({"document":output,"exported":true,"exportedRevision":snapshot.revision,"warning":warning.or(checkpoint_warning)}),
        )
    }
}
fn write_export(
    s: &ExportSnapshot,
    request: Request,
    cancel: &AtomicBool,
    progress: &Progress,
) -> Result<Option<&'static str>> {
    let path = request
        .path
        .ok_or_else(|| issue("Missing export destination"))?;
    if !path.is_absolute()
        || path.exists()
        || path
            .extension()
            .and_then(|v| v.to_str())
            .is_none_or(|v| !v.eq_ignore_ascii_case(&s.format))
    {
        return Err(issue(
            "Choose a new file with the source extension; existing files are never overwritten",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| issue("Invalid export directory"))?;
    let temporary = parent.join(format!(
        ".futureox-large-{}-{}.partial",
        s.owner.document_id, s.revision
    ));
    let output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(issue)?;
    let result = (|| -> Result<()> {
        if hash_range(
            &s.directory.join("source"),
            Span {
                start: 0,
                end: if s.format == "json" {
                    s.parts[0].base_bytes
                } else {
                    File::open(s.directory.join("source"))
                        .map_err(issue)?
                        .metadata()
                        .map_err(issue)?
                        .len()
                },
            },
            cancel,
        )
        .map_err(issue)?
            != s.source_hash
        {
            return Err(issue("Retained source integrity check failed"));
        }
        for part in &s.parts {
            for addition in &part.additions {
                if hash_range(&s.directory.join(&part.file), addition.span, cancel)
                    .map_err(issue)?
                    != addition.sha256
                {
                    return Err(issue("Retained JSON addition integrity check failed"));
                }
            }
        }
        progress.phase(
            "export",
            s.parts
                .iter()
                .enumerate()
                .map(|(p, part)| {
                    s.state.changes[p]
                        .output_bytes(part.base_bytes)
                        .unwrap_or(0)
                })
                .sum(),
        );
        if s.format == "json" {
            let mut file = CheckedReader {
                inner: File::open(s.directory.join(&s.parts[0].file)).map_err(issue)?,
                cancel,
                progress: Some(progress),
            };
            let mut writer = BufWriter::new(output);
            s.state.changes[0]
                .export(&mut file, &mut writer, s.parts[0].base_bytes)
                .map_err(issue)?;
            writer.flush().map_err(issue)?;
            writer.get_ref().sync_all().map_err(issue)?;
        } else {
            let mut archive =
                zip::ZipArchive::new(File::open(s.directory.join("source")).map_err(issue)?)
                    .map_err(issue)?;
            let mut writer = zip::ZipWriter::new(output);
            for i in 0..archive.len() {
                check_cancel(cancel).map_err(issue)?;
                let entry = archive.by_index(i).map_err(issue)?;
                if let Some((p, part)) = s
                    .parts
                    .iter()
                    .enumerate()
                    .find(|(_, p)| p.name == entry.name())
                {
                    if hash_range(
                        &s.directory.join(&part.file),
                        Span {
                            start: 0,
                            end: part.base_bytes,
                        },
                        cancel,
                    )
                    .map_err(issue)?
                        != part.hash
                    {
                        return Err(issue("Retained JSON part integrity check failed"));
                    }
                    let bytes = s.state.changes[p]
                        .output_bytes(part.base_bytes)
                        .map_err(issue)?;
                    writer
                        .start_file(
                            &part.name,
                            zip::write::SimpleFileOptions::default()
                                .compression_method(zip::CompressionMethod::Deflated)
                                .large_file(bytes >= u32::MAX as u64),
                        )
                        .map_err(issue)?;
                    let mut file = CheckedReader {
                        inner: File::open(s.directory.join(&part.file)).map_err(issue)?,
                        cancel,
                        progress: Some(progress),
                    };
                    s.state.changes[p]
                        .export(&mut file, &mut writer, part.base_bytes)
                        .map_err(issue)?;
                } else {
                    writer.raw_copy_file(entry).map_err(issue)?;
                }
            }
            let file = writer.finish().map_err(issue)?;
            file.sync_all().map_err(issue)?;
        }
        check_cancel(cancel).map_err(issue)?;
        fs::hard_link(&temporary, &path).map_err(issue)?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result?;
    let warning = File::open(parent)
        .and_then(|f| f.sync_all())
        .err()
        .map(|_| "Export was published, but directory synchronization was not confirmed");
    Ok(warning)
}

#[cfg(test)]
mod tests {
    // Keep the historical large-fixture size independent of host capacity.
    const MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[test]
    fn cancelled_stream_copy_propagates_instead_of_retrying() {
        let cancel = AtomicBool::new(true);
        assert_ne!(
            check_cancel(&cancel).unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
        let mut reader = CheckedReader {
            inner: io::Cursor::new(b"source"),
            cancel: &cancel,
            progress: None,
        };
        assert!(
            io::copy(&mut reader, &mut Vec::new())
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
    }
    #[test]
    fn source_archive_uses_storage_capacity_instead_of_entry_and_compression_quotas() {
        let f = Fixture::new();
        let path = f.root.join("many-members.sketch");
        let original = format!("{{\"padding\":\"{}\",\"name\":\"retained\"}}", " ".repeat(2 * 1024 * 1024));
        let long_name = format!("images/{}asset.bin", "segment/".repeat(200));
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("document.json", options).unwrap();
        writer.write_all(original.as_bytes()).unwrap();
        writer.start_file("meta.json", options).unwrap(); writer.write_all(br#"{"version":136}"#).unwrap();
        for i in 0..4097 { writer.start_file(format!("images/{i}.bin"), options).unwrap(); }
        writer.start_file(&long_name, options).unwrap(); writer.write_all(b"exact").unwrap();
        writer.finish().unwrap();
        let mut archive = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let member = archive.by_name("document.json").unwrap();
        assert!(member.size() > 200 * member.compressed_size());
        drop(member);
        let opened = f.open(path.clone());
        let output = f.root.join("complete.sketch");
        call(&f, &opened, "large.export", json!({"path":output}));
        let mut result = zip::ZipArchive::new(File::open(output).unwrap()).unwrap();
        assert_eq!(result.len(), archive.len());
        let mut actual = String::new(); result.by_name("document.json").unwrap().read_to_string(&mut actual).unwrap();
        assert_eq!(actual, original);
        actual.clear(); result.by_name(&long_name).unwrap().read_to_string(&mut actual).unwrap(); assert_eq!(actual, "exact");
        call(&f, &opened, "large.close", json!({}));
        let reopened = f.open(path);
        assert_eq!(reopened["indexedObjects"], opened["indexedObjects"]);
        assert_eq!(reopened["expandedBytes"], opened["expandedBytes"]);
    }
    #[test]
    fn scalar_to_container_edits_publish_the_same_index_as_reopen() {
        let f = Fixture::new();
        let path = f.root.join("structure.json");
        fs::write(&path, br#"{"extra":1}"#).unwrap();
        let status = f.open(path);
        let read = call(&f, &status, "large.read", json!({"key":"0:0"}));
        let next = call(
            &f,
            &status,
            "large.apply",
            json!({"key":"0:0","json":"{\"extra\":{\"name\":\"new child\"}}","expectedHash":read["hash"],"requestId":"new-container"}),
        );
        assert_eq!(next["indexedObjects"], 2);
        assert_eq!(
            call(&f, &next, "large.children", json!({"query":"new child"}))["total"],
            1
        );
    }
    #[test]
    fn navigation_and_fragment_cache_follow_source_revision() {
        let f = Fixture::new();
        let path = f.root.join("cache.json");
        fs::write(&path, br#"{"layers":[{"id":"a","name":"child"}]}"#).unwrap();
        let status = f.open(path);
        let listing = call(&f, &status, "large.children", json!({"key":"0:0"}));
        assert_eq!(listing["total"], 1);
        let key = listing["items"][0]["key"].as_str().unwrap();
        let read = call(&f, &status, "large.read", json!({"key":key}));
        assert_eq!(read, call(&f, &status, "large.read", json!({"key":key})));
        assert_eq!(f.sessions.fragments.lock().unwrap().items.len(), 1);
        let changed = read["json"].as_str().unwrap().replace("child", "changed");
        let next = call(
            &f,
            &status,
            "large.apply",
            json!({"key":key,"json":changed,"expectedHash":read["hash"],"requestId":"cache-edit"}),
        );
        assert_eq!(
            call(&f, &next, "large.children", json!({"query":"changed"}))["total"],
            1
        );
        assert_eq!(
            call(&f, &next, "large.children", json!({"query":"child"}))["total"],
            0
        );
        assert!(
            call(&f, &next, "large.read", json!({"key":key}))["json"]
                .as_str()
                .unwrap()
                .contains("changed")
        );
        let undone = call(&f, &next, "large.undo", json!({}));
        assert_eq!(
            call(&f, &undone, "large.children", json!({"query":"child"}))["total"],
            1
        );
    }
    struct Fixture {
        root: PathBuf,
        sessions: Sessions,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "futureox-large-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let sessions = Sessions::new(root.join("cache"));
            Self { root, sessions }
        }
        fn open(&self, path: PathBuf) -> Value {
            static EPOCH: AtomicUsize = AtomicUsize::new(1);
            let epoch = EPOCH.fetch_add(1, Ordering::Relaxed) as u64;
            self.sessions
                .open(
                    Open {
                        path,
                        document_id: "test-document".into(),
                        session_epoch: epoch,
                    },
                    &AtomicBool::new(false),
                )
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn request(status: &Value, extra: Value) -> Request {
        let mut value = json!({"owner":status["owner"],"expectedRevision":status["revision"]});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }
    fn call(f: &Fixture, status: &Value, method: &str, extra: Value) -> Value {
        f.sessions
            .dispatch(method, request(status, extra), &AtomicBool::new(false))
            .unwrap()
    }
    fn equal_outside(before: &Path, after: &Path, edited: Span) {
        let mut before = File::open(before).unwrap();
        let mut after = File::open(after).unwrap();
        let mut a = [0u8; 65536];
        let mut b = [0u8; 65536];
        let mut at = 0u64;
        loop {
            let n = before.read(&mut a).unwrap();
            if n == 0 {
                assert_eq!(after.read(&mut b).unwrap(), 0);
                break;
            }
            after.read_exact(&mut b[..n]).unwrap();
            let left = (edited.start.clamp(at, at + n as u64) - at) as usize;
            let right = (edited.end.clamp(at, at + n as u64) - at) as usize;
            assert!(a[..left] == b[..left], "Unchanged prefix chunk at {at}");
            assert!(a[right..n] == b[right..n], "Unchanged suffix chunk at {at}");
            at += n as u64;
        }
    }
    fn field_span(f: &Fixture, key: &str, name: &str) -> Span {
        let slot = f.sessions.current.lock().unwrap();
        let s = slot.as_ref().unwrap();
        let (p, n) = location(s, Some(key)).unwrap();
        s.parts[p]
            .index
            .entry(n, &s.directory)
            .unwrap()
            .fields
            .into_iter()
            .find(|field| field.key == name)
            .unwrap()
            .value
    }
    #[test]
    fn property_edits_history_and_full_export_preserve_unloaded_bytes() {
        let f = Fixture::new();
        let path = f.root.join("source.json");
        let source=br#"{"edit":{"name":"before","n":-0.0},"unknown":1844674407370955161600000,"payload":[1,{"untouched":true}]}"#;
        fs::write(&path, source).unwrap();
        let status = f.open(path.clone());
        let read = call(&f, &status, "large.read", json!({"key":"0:1"}));
        let changed = read["json"]
            .as_str()
            .unwrap()
            .replace("before", "after-longer");
        let status = call(
            &f,
            &status,
            "large.apply",
            json!({"key":"0:1","json":changed,"expectedHash":read["hash"],"requestId":"edit-1"}),
        );
        let status = call(&f, &status, "large.undo", json!({}));
        let status = call(&f, &status, "large.redo", json!({}));
        let output = f.root.join("output.json");
        call(&f, &status, "large.export", json!({"path":output}));
        assert_eq!(
            fs::read(&output).unwrap(),
            String::from_utf8(source.to_vec())
                .unwrap()
                .replace("before", "after-longer")
                .as_bytes()
        );
        assert_eq!(fs::read(path).unwrap(), source);
        assert!(
            f.sessions
                .dispatch(
                    "large.apply",
                    request(
                        &status,
                        json!({"key":"0:1","json":"{}","expectedHash":"bad","requestId":"edit-2"})
                    ),
                    &AtomicBool::new(false)
                )
                .is_err()
        );
    }
    #[test]
    fn invalid_duplicate_keys_stale_revision_and_cancellation_are_atomic() {
        let f = Fixture::new();
        let path = f.root.join("source.json");
        fs::write(&path, br#"{"name":"before"}"#).unwrap();
        let status = f.open(path);
        let read = call(&f, &status, "large.read", json!({"key":"0:0"}));
        for data in [
            r#"{"name":"a","name":"b"}"#,
            r#"{"name":NaN}"#,
            r#"{"id":"injected"}"#,
        ] {
            assert!(f.sessions.dispatch("large.apply",request(&status,json!({"key":"0:0","json":data,"expectedHash":read["hash"],"requestId":"bad"})),&AtomicBool::new(false)).is_err());
            assert_eq!(call(&f, &status, "large.status", json!({}))["revision"], 0);
        }
        assert!(f.sessions.dispatch("large.apply",request(&status,json!({"key":"0:0","json":r#"{"name":"after"}"#,"expectedHash":read["hash"],"requestId":"cancel"})),&AtomicBool::new(true)).is_err());
        let mut stale = request(&status, json!({}));
        stale.expected_revision = 99;
        assert!(
            f.sessions
                .dispatch("large.undo", stale, &AtomicBool::new(false))
                .is_err()
        );
        assert_eq!(call(&f, &status, "large.status", json!({}))["revision"], 0);
    }
    #[test]
    fn corrupted_retained_source_cannot_publish_export() {
        let f = Fixture::new();
        let path = f.root.join("source.json");
        fs::write(&path, br#"{"name":"before"}"#).unwrap();
        let status = f.open(path);
        let directory = f
            .sessions
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .directory
            .clone();
        fs::write(directory.join("source"), br#"{"name":"forged"}"#).unwrap();
        let output = f.root.join("output.json");
        assert!(
            f.sessions
                .dispatch(
                    "large.export",
                    request(&status, json!({"path":output})),
                    &AtomicBool::new(false)
                )
                .is_err()
        );
        assert!(!output.exists());
    }
    #[test]
    fn durable_edits_recover_after_backend_recreation() {
        let f = Fixture::new();
        let path = f.root.join("source.json");
        fs::write(&path, br#"{"name":"before","unknown":-0.0}"#).unwrap();
        let status = f.open(path.clone());
        let read = call(&f, &status, "large.read", json!({"key":"0:0"}));
        let status = call(
            &f,
            &status,
            "large.apply",
            json!({"key":"0:0","json":read["json"].as_str().unwrap().replace("before","recovered"),"expectedHash":read["hash"],"requestId":"recover-edit"}),
        );
        call(&f, &status, "large.close", json!({}));
        let sessions = Sessions::new(f.root.join("cache"));
        let status = sessions
            .open(
                Open {
                    path,
                    document_id: "fresh-owner".into(),
                    session_epoch: 2,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(status["revision"], 1);
        assert_eq!(status["owner"]["documentId"], "fresh-owner");
        let read = sessions
            .dispatch(
                "large.read",
                request(&status, json!({"key":"0:0"})),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert!(read["json"].as_str().unwrap().contains("recovered"));
        assert!(read["json"].as_str().unwrap().contains("-0.0"));
    }
    #[test]
    fn ordinary_scene_working_set_uses_shared_admission_and_preserves_unknown_source_fields() {
        let f = Fixture::new();
        let id = "20000000-0000-4000-8000-000000000001";
        let node = futureox_design_kernel::facet::sample_node(id, "rectangle");
        let mut value = json!({"schemaVersion":1,"id":"20000000-0000-4000-8000-000000000002","name":"source","pages":[{"id":"20000000-0000-4000-8000-000000000003","name":"Page","children":[id],"background":"#ffffff"}],"nodes":{(id):node},"cold":-0.0});
        value["nodes"][id]["unknown"] = json!("untouched");
        let path = f.root.join("scene.json");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let status = f.open(path);
        let key = {
            let slot = f.sessions.current.lock().unwrap();
            let s = slot.as_ref().unwrap();
            format!(
                "0:{}",
                s.parts[0]
                    .index
                    .entries
                    .iter()
                    .position(|e| e.id == id)
                    .unwrap()
            )
        };
        let projected = call(
            &f,
            &status,
            "large.project",
            json!({"key":key,"workingDocumentId":"20000000-0000-4000-8000-000000000099"}),
        );
        let mut document: futureox_design_kernel::scene::Document =
            serde_json::from_str(projected["json"].as_str().unwrap()).unwrap();
        document.nodes.get_mut(id).unwrap().name = "canvas-edit".into();
        document.validate().unwrap();
        let status = call(
            &f,
            &status,
            "large.commitCanvas",
            json!({"key":key,"json":serde_json::to_string(&document).unwrap(),"requestId":"scene-edit"}),
        );
        let output = f.root.join("scene-edited.json");
        call(&f, &status, "large.export", json!({"path":output}));
        let text = fs::read_to_string(output).unwrap();
        assert!(text.contains("canvas-edit"));
        assert!(text.contains("untouched"));
        assert!(text.contains("-0.0"));
    }
    #[test]
    #[ignore = "explicit local 5 GiB disk/index/edit/export acceptance; writes about 15 GiB temporarily"]
    fn actual_five_gib_json_edits_exports_and_refuses_storage_overflow() {
        const SOURCE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
        let f = Fixture::new();
        let path = f.root.join("five-gib.json");
        let head = br#"{"edit":{"name":"before","n":-0.0},"payload":""#;
        let tail = b"\"}";
        let mut file = BufWriter::new(File::create(&path).unwrap());
        file.write_all(head).unwrap();
        let bytes = [b'x'; 1024 * 1024];
        let mut remaining = SOURCE_BYTES - head.len() as u64 - tail.len() as u64;
        while remaining > 0 {
            let count = remaining.min(bytes.len() as u64) as usize;
            file.write_all(&bytes[..count]).unwrap();
            remaining -= count as u64;
        }
        file.write_all(tail).unwrap();
        file.flush().unwrap();
        file.get_ref().sync_all().unwrap();
        drop(file);
        assert_eq!(fs::metadata(&path).unwrap().len(), 5_368_709_120);
        let status = f.open(path.clone());
        assert_eq!(status["expandedBytes"], 5_368_709_120u64);
        let read = call(&f, &status, "large.read", json!({"key":"0:1"}));
        let name_span = field_span(&f, "0:1", "name");
        let changed = read["json"].as_str().unwrap().replace("before", "after!");
        let status = call(
            &f,
            &status,
            "large.apply",
            json!({"key":"0:1","json":changed,"expectedHash":read["hash"],"requestId":"four-gib-edit"}),
        );
        let output = f.root.join("exported.json");
        call(&f, &status, "large.export", json!({"path":output}));
        assert_eq!(fs::metadata(&output).unwrap().len(), SOURCE_BYTES);
        equal_outside(&path, &output, name_span);
        let mut input = File::open(&output).unwrap();
        let mut prefix = [0u8; 80];
        input.read_exact(&mut prefix).unwrap();
        assert!(String::from_utf8_lossy(&prefix).contains("after!"));
        assert!(String::from_utf8_lossy(&prefix).contains("-0.0"));
        let index = large_json::index(File::open(&output).unwrap(), SOURCE_BYTES).unwrap();
        assert_eq!(index.bytes, SOURCE_BYTES);
        let over = f.root.join("over.json");
        File::create(&over)
            .unwrap()
            .set_len(capacity::source_limit(&f.root).unwrap() + 1)
            .unwrap();
        let sessions = Sessions::new(f.root.join("over-cache"));
        assert!(
            sessions
                .open(
                    Open {
                        path: over,
                        document_id: "over".into(),
                        session_epoch: 1
                    },
                    &AtomicBool::new(false)
                )
                .unwrap_err()
                .message
                .contains("storage capacity")
        );
        println!(
            "5GiB source accepted, edited and exported; actual backing-volume capacity +1 byte rejected before copy"
        );
    }
    #[test]
    #[ignore = "explicit 4 GiB structured JSON acceptance from repeated real page data, not a single-string-only probe"]
    fn actual_four_gib_structured_json_indexes_and_exports_with_bounded_memory() {
        let source = PathBuf::from(
            std::env::var("CORE_LARGE_SKETCH_INPUT").expect("Set the user-owned Sketch input"),
        );
        let f = Fixture::new();
        let path = f.root.join("four-gib-structured.json");
        let mut archive = zip::ZipArchive::new(File::open(source).unwrap()).unwrap();
        let pages: Vec<String> = archive
            .file_names()
            .filter(|name| name.starts_with("pages/") && name.ends_with(".json"))
            .map(str::to_owned)
            .collect();
        let mut output = BufWriter::new(File::create(&path).unwrap());
        let mut written = 0u64;
        let head = b"{\"pages\":[";
        output.write_all(head).unwrap();
        written += head.len() as u64;
        let mut count = 0;
        for _ in 0..5 {
            for page in &pages {
                if count > 0 {
                    output.write_all(b",").unwrap();
                    written += 1;
                }
                written += io::copy(&mut archive.by_name(page).unwrap(), &mut output).unwrap();
                count += 1;
            }
        }
        let middle = br#"],"edit":{"name":"before","n":-0.0},"padding":""#;
        output.write_all(middle).unwrap();
        written += middle.len() as u64;
        let tail = b"\"}";
        assert!(written + (tail.len() as u64) < MAX_EXPANDED_BYTES);
        let mut remaining = MAX_EXPANDED_BYTES - written - tail.len() as u64;
        let bytes = [b'x'; 1024 * 1024];
        while remaining > 0 {
            let n = remaining.min(bytes.len() as u64) as usize;
            output.write_all(&bytes[..n]).unwrap();
            remaining -= n as u64;
        }
        output.write_all(tail).unwrap();
        output.flush().unwrap();
        output.get_ref().sync_all().unwrap();
        drop(output);
        let status = f.open(path.clone());
        assert_eq!(status["expandedBytes"], MAX_EXPANDED_BYTES);
        assert!(status["indexedObjects"].as_u64().unwrap() > 500_000);
        let key = {
            let slot = f.sessions.current.lock().unwrap();
            let s = slot.as_ref().unwrap();
            format!(
                "0:{}",
                s.parts[0]
                    .index
                    .entries
                    .iter()
                    .position(|e| e.name == "before" && e.kind == "object")
                    .unwrap()
            )
        };
        let read = call(&f, &status, "large.read", json!({"key":key}));
        let name_span = field_span(&f, &key, "name");
        let status = call(
            &f,
            &status,
            "large.apply",
            json!({"key":key,"json":read["json"].as_str().unwrap().replace("before","after!"),"expectedHash":read["hash"],"requestId":"structured-edit"}),
        );
        let target = f.root.join("structured-edited.json");
        call(&f, &status, "large.export", json!({"path":target}));
        assert_eq!(fs::metadata(&target).unwrap().len(), MAX_EXPANDED_BYTES);
        equal_outside(&path, &target, name_span);
        let summary = large_json::scan(
            File::open(target).unwrap(),
            MAX_EXPANDED_BYTES,
            |_, entry| {
                if entry.name == "after!" {
                    println!("structured edited object validated");
                }
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(summary.bytes, MAX_EXPANDED_BYTES);
        assert!(summary.entries > 500_000);
        println!(
            "structured 4GiB acceptance: {} indexed objects; five copies of original page JSON including about ten million curve points; exact 4294967296-byte export",
            summary.entries
        );
    }
    #[test]
    fn scene_layout_can_be_saved_removed_and_saved_again_without_losing_source_members() {
        let f=Fixture::new();let input=f.root.join("layout.sketch");
        let page=json!({"_class":"page","do_objectID":"p","name":"Page","layers":[{"_class":"artboard","do_objectID":"n","name":"Layout target","frame":{"width":200,"height":120},"unknown":{"keep":[1,2,3]},"layers":[]}]});
        let mut zip=zip::ZipWriter::new(File::create(&input).unwrap());
        for(name,value)in[("meta.json",json!({"version":136})),("document.json",json!({"pages":[{"_ref":"pages/p"}]})),("pages/p.json",page.clone())]{zip.start_file(name,zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();}zip.finish().unwrap();
        let opened=f.open(input);let rows=call(&f,&opened,"large.children",json!({"query":"Layout target"}));let key=rows["items"][0]["key"].as_str().unwrap();
        call(&f,&opened,"large.scene",json!({"key":key}));
        let with_layout=call(&f,&opened,"large.sceneCommit",json!({"key":key,"json":json!({"n":{"patch":{"layout":{"mode":"vertical","gap":12,"padding":[16,16,16,16]}}}}).to_string(),"requestId":"layout-add"}));
        let without=call(&f,&with_layout,"large.sceneCommit",json!({"key":key,"json":json!({"n":{"patch":{"layout":null}}}).to_string(),"requestId":"layout-remove"}));
        let read=call(&f,&without,"large.read",json!({"key":key}));let node:Value=serde_json::from_str(read["json"].as_str().unwrap()).unwrap();
        assert_eq!(node["unknown"],page["layers"][0]["unknown"]);
        let output=f.root.join("layout-removed.sketch");call(&f,&without,"large.export",json!({"path":output}));
        let mut archive=zip::ZipArchive::new(File::open(output).unwrap()).unwrap();assert_eq!(archive.len(),3);
        let mut bytes=Vec::new();archive.by_name("pages/p.json").unwrap().read_to_end(&mut bytes).unwrap();
        let final_page:Value=serde_json::from_slice(&bytes).unwrap();
        // The existing compatibility exporter adds its stable identity marker
        // on the first layout edit. Removing layout must remove only the layout
        // semantics; neither opaque source data nor that identity is discarded.
        let mut expected=page;expected["layers"][0]["userInfo"]=json!({"com.futureox.design-kernel":{"originalId":"n"}});
        assert_eq!(final_page,expected);
        let undo=call(&f,&without,"large.undo",json!({"requestId":"undo-remove"}));
        let redo=call(&f,&undo,"large.redo",json!({"requestId":"redo-remove"}));
        let read=call(&f,&redo,"large.read",json!({"key":key}));assert_eq!(serde_json::from_str::<Value>(read["json"].as_str().unwrap()).unwrap(),node);
    }
    #[test]
    fn scene_scale_updates_only_frame_when_source_points_exceed_fragment_budget() {
        let f=Fixture::new();let input=f.root.join("dense.sketch");
        let points=(0..10001).map(|i|{let a=i as f64*std::f64::consts::TAU/10001.;json!({"_class":"curvePoint","point":format!("{{{}, {}}}",0.5+0.4*a.cos(),0.5+0.4*a.sin()),"hasCurveFrom":false,"hasCurveTo":false,"private":-0.0,"opaque":"x".repeat(256)})}).collect::<Vec<_>>();
        let page=json!({"_class":"page","do_objectID":"p","name":"Page","layers":[{"_class":"shapePath","do_objectID":"n","name":"Large path","isClosed":true,"frame":{"width":20,"height":10},"points":points}]});
        let original=serde_json::to_vec(&page).unwrap();assert!(original.len()>2*1024*1024);
        let mut zip=zip::ZipWriter::new(File::create(&input).unwrap());
        for (name,bytes) in [("meta.json",br#"{"version":136}"#.to_vec()),("document.json",br#"{"pages":[{"_ref":"pages/p"}]}"#.to_vec()),("pages/p.json",original.clone())]{zip.start_file(name,zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();zip.write_all(&bytes).unwrap();}zip.finish().unwrap();
        let opened=f.open(input);let rows=call(&f,&opened,"large.children",json!({"query":"Large path"}));let key=rows["items"][0]["key"].as_str().unwrap();
        call(&f,&opened,"large.scene",json!({"key":key}));
        let changed=call(&f,&opened,"large.sceneCommit",json!({"key":key,"json":json!({"n":{"patch":{"width":40},"geometryScale":[2,1]}}).to_string(),"requestId":"scale"}));
        let read=call(&f,&changed,"large.read",json!({"key":key}));assert!(read["omittedFields"].as_array().unwrap().contains(&json!("points")));
        assert_eq!(serde_json::from_str::<Value>(read["json"].as_str().unwrap()).unwrap()["frame"]["width"].as_f64(),Some(40.));
        let output=f.root.join("edited.sketch");call(&f,&changed,"large.export",json!({"path":output}));
        let mut archive=zip::ZipArchive::new(File::open(output).unwrap()).unwrap();let mut bytes=Vec::new();archive.by_name("pages/p.json").unwrap().read_to_end(&mut bytes).unwrap();
        let before:BTreeMap<String,Box<RawValue>>=serde_json::from_slice(&original).unwrap();let after:BTreeMap<String,Box<RawValue>>=serde_json::from_slice(&bytes).unwrap();
        let before:Vec<BTreeMap<String,Box<RawValue>>>=serde_json::from_str(before["layers"].get()).unwrap();let after:Vec<BTreeMap<String,Box<RawValue>>>=serde_json::from_str(after["layers"].get()).unwrap();assert_eq!(before[0]["points"].get(),after[0]["points"].get());
        let bad=request(&changed,json!({"key":key,"json":json!({"n":{"patch":{"width":80},"geometryScale":[3,1]}}).to_string(),"requestId":"bad-scale"}));assert!(f.sessions.dispatch("large.sceneCommit",bad,&AtomicBool::new(false)).is_err());assert_eq!(call(&f,&changed,"large.status",json!({}))["revision"],changed["revision"]);
    }
    #[test]
    #[ignore = "real complete source page, property commit and full export"]
    fn actual_topology_complete_controls_page() {
        let f = Fixture::new();
        let source = PathBuf::from(std::env::var("CORE_LARGE_SKETCH_INPUT").unwrap());
        let opened = f.open(source.clone());
        let key = {
            let slot = f.sessions.current.lock().unwrap();
            let s = slot.as_ref().unwrap();
            let p = s.parts.iter().position(|p| p.index.entries.first().is_some_and(|e| e.kind == "page" && e.name == "控件")).unwrap();
            format!("{p}:0")
        };
        let loaded = call(&f, &opened, "large.scene", json!({"key":key}));
        assert!(loaded["nodes"].as_u64().unwrap() >= 700);
        let mut json_bytes = Vec::new();
        while json_bytes.len() < loaded["bytes"].as_u64().unwrap() as usize {
            let chunk = call(&f, &opened, "large.sceneRead", json!({"key":key,"offset":json_bytes.len()}));
            use base64::Engine;
            json_bytes.extend(base64::engine::general_purpose::STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap());
        }
        assert_eq!(digest(&json_bytes), loaded["hash"].as_str().unwrap());
        let mut doc: futureox_design_kernel::scene::Document = serde_json::from_slice(&json_bytes).unwrap();
        assert_eq!(doc.pages[0].children.len(), 42);
        if let Ok(path) = std::env::var("CORE_PAGE_SCENE_OUTPUT") { fs::write(path, &json_bytes).unwrap(); }
        let node = doc.nodes.values_mut().find(|n| n.kind == "rectangle" && n.component.is_none()).unwrap();
        let id=node.id.clone();node.name.push_str(" page-save-test");
        let changed=call(&f,&opened,"large.sceneCommit",json!({"key":key,"json":json!({id:{"patch":{"name":node.name}}}).to_string(),"requestId":"page-edit"}));
        assert_eq!(changed["revision"],1);
        let instance_id="0D747267-A0CA-40C0-BEFD-846C10CD98F2";
        let mut instance=doc.nodes[instance_id].instance.clone().unwrap();
        instance.overrides.entry("$root".into()).or_default().insert("width".into(),json!(120));
        let changed=call(&f,&changed,"large.sceneCommit",json!({"key":key,"json":json!({instance_id:{"patch":{"width":120,"instance":instance}}}).to_string(),"requestId":"instance-resize"}));
        assert_eq!(changed["revision"],2);
        let output=f.root.join("page-edited.sketch");
        call(&f,&changed,"large.export",json!({"path":output}));
        let original=zip::ZipArchive::new(File::open(source).unwrap()).unwrap();
        let mut exported=zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        assert_eq!(original.len(),exported.len());
        let part = {let slot=f.sessions.current.lock().unwrap();slot.as_ref().unwrap().parts[key.split(':').next().unwrap().parse::<usize>().unwrap()].name.clone()};
        let mut text=String::new();exported.by_name(&part).unwrap().read_to_string(&mut text).unwrap();
        assert!(text.contains("page-save-test"));
        fn find_layer<'a>(v:&'a Value,id:&str)->Option<&'a Value>{
            if v.get("do_objectID").and_then(Value::as_str)==Some(id){return Some(v)}
            v.get("layers").and_then(Value::as_array)?.iter().find_map(|v|find_layer(v,id))
        }
        let page:Value=serde_json::from_str(&text).unwrap();
        assert_eq!(find_layer(&page,instance_id).unwrap()["frame"]["width"].as_f64(),Some(120.));
        call(&f,&changed,"large.close",json!({}));
        let reopened=f.open(output.clone());
        call(&f,&reopened,"large.scene",json!({"key":key}));
        {let slot=f.sessions.current.lock().unwrap();let node=&slot.as_ref().unwrap().scene.as_ref().unwrap().document.nodes[instance_id];assert_eq!(node.width,120.);assert_eq!(node.instance.as_ref().unwrap().overrides["$root"]["width"].as_f64(),Some(120.));}
        println!("complete page: {} nodes, {} source roots, {} model bytes; edited property persisted in full {}-member export",loaded["nodes"],doc.pages[0].children.len(),loaded["bytes"],exported.len());
    }
    #[test]
    #[ignore = "full native source-canvas materialization; never a GUI/GPU acceptance"]
    fn actual_source_single_artboard_snapshot() {
        let f=Fixture::new();
        let opened=f.open(PathBuf::from(std::env::var("CORE_LARGE_SKETCH_INPUT").unwrap()));
        let started=std::time::Instant::now();
        let result=call(&f,&opened,"large.canvasSnapshot",json!({}));
        assert_eq!(result["roots"],306);
        println!("{}",json!({"phase":"native-canvas-snapshot","seconds":started.elapsed().as_secs_f64(),"bytes":result["bytes"],"nodes":result["nodes"],"roots":result["roots"],"hash":result["hash"],"bounds":result["bounds"]}));
        if let Ok(path)=std::env::var("CORE_CANVAS_SNAPSHOT_OUTPUT") {
            fs::copy(result["path"].as_str().unwrap(),path).unwrap();
        }
    }
    #[test]
    #[ignore = "real source conversion-cache timing, not GUI or GPU acceptance"]
    fn actual_source_canvas_window_reuse() {
        let f = Fixture::new();
        let opened = f.open(PathBuf::from(std::env::var("CORE_LARGE_SKETCH_INPUT").unwrap()));
        let key = {
            let slot = f.sessions.current.lock().unwrap(); let s = slot.as_ref().unwrap();
            s.parts.iter().enumerate().find_map(|(p, part)|part.index.entries.iter().enumerate()
                .find(|(_,row)|row.id == "08856B36-020D-46FC-AC59-55F38CDB82BE").map(|(n,_)|format!("{p}:{n}"))).unwrap()
        };
        let mut hashes = Vec::new();
        for round in 0..2 {
            let start = std::time::Instant::now();
            let result = call(&f, &opened, "large.scene", json!({"key":key}));
            hashes.push(result["hash"].clone());
            let slot = f.sessions.current.lock().unwrap(); let s = slot.as_ref().unwrap();
            println!("{}",json!({"round":round,"seconds":start.elapsed().as_secs_f64(),"nodes":result["nodes"],"bytes":result["bytes"],"hash":result["hash"],"cacheHits":s.converted_windows.lock().unwrap().hits}));
        }
        assert_eq!(hashes[0],hashes[1]);
    }
    #[test]
    #[ignore = "real whole-source canvas catalogue; no scene or GPU acceptance"]
    fn actual_source_canvas_catalogue() {
        let f = Fixture::new();
        let input = PathBuf::from(std::env::var("CORE_LARGE_SKETCH_INPUT").unwrap());
        let source_hash = hash_file(&input, &AtomicBool::new(false)).unwrap();
        let opened = f.open(input.clone());
        let mut items = Vec::new();
        let mut bounds = Value::Null;
        loop {
            let listed = call(&f, &opened, "large.canvasLayout", json!({"offset":items.len(),"limit":200}));
            assert_eq!(listed["total"], 306);
            assert_eq!(listed["offset"], items.len());
            assert_eq!(listed["boundsAreLayoutHints"], true);
            if bounds.is_null() { bounds = listed["bounds"].clone(); }
            assert_eq!(listed["bounds"], bounds);
            items.extend(listed["items"].as_array().unwrap().clone());
            if listed["hasMore"] == false { break; }
        }
        let mut pages = BTreeMap::<String, usize>::new();
        let mut kinds = BTreeMap::<String, usize>::new();
        let mut ids = HashSet::new();
        for item in &items {
            assert!(ids.insert(item["id"].as_str().unwrap()));
            *pages.entry(item["pageName"].as_str().unwrap().into()).or_default() += 1;
            *kinds.entry(item["kind"].as_str().unwrap().into()).or_default() += 1;
            let placed = &item["placed"];
            for axis in ["x", "y", "width", "height"] { assert!(placed[axis].as_f64().unwrap().is_finite()); }
            assert!(placed["x"].as_f64().unwrap() + placed["width"].as_f64().unwrap() <= bounds["width"].as_f64().unwrap());
            assert!(placed["y"].as_f64().unwrap() + placed["height"].as_f64().unwrap() <= bounds["height"].as_f64().unwrap());
        }
        assert_eq!(pages, BTreeMap::from([("浅色".into(),209),("深色".into(),55),("控件".into(),42)]));
        assert_eq!(hash_file(&input, &AtomicBool::new(false)).unwrap(), source_hash);
        let output = f.root.join("canvas-catalogue-export.sketch");
        call(&f, &opened, "large.export", json!({"path":output}));
        let mut original = zip::ZipArchive::new(File::open(&input).unwrap()).unwrap();
        let mut exported = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        assert_eq!(original.len(), exported.len());
        fn content_hash(mut source: impl Read) -> String {
            let mut digest = Sha256::new(); let mut bytes = [0u8; 64 * 1024];
            loop { let count = source.read(&mut bytes).unwrap(); if count == 0 { break; } digest.update(&bytes[..count]); }
            format!("{:x}", digest.finalize())
        }
        for i in 0..original.len() {
            let member = original.by_index(i).unwrap(); let name = member.name().to_owned();
            assert_eq!(content_hash(member), content_hash(exported.by_name(&name).unwrap()), "{name}");
        }
        println!("{}",json!({"sourceSha256":source_hash,"roots":items.len(),"pages":pages,"kinds":kinds,"bounds":bounds,"byteIdenticalExportMembers":exported.len()}));
        if let Ok(path) = std::env::var("CORE_CANVAS_CATALOGUE_OUTPUT") {
            fs::write(path, serde_json::to_vec(&json!({"sourceSha256":source_hash,"bounds":bounds,"items":items})).unwrap()).unwrap();
        }
    }
    #[test]
    #[ignore = "real source page ranges under the unchanged session allowance"]
    fn actual_source_page_segments() {
        let f = Fixture::new();
        let opened = f.open(PathBuf::from(std::env::var("CORE_LARGE_SKETCH_INPUT").unwrap()));
        for (name, expected) in [("控件",42), ("深色",55), ("浅色",209)] {
            let key = {
                let slot = f.sessions.current.lock().unwrap();
                let s = slot.as_ref().unwrap();
                let p = s.parts.iter().position(|p| p.index.entries.first().is_some_and(|e| e.kind == "page" && e.name == name)).unwrap();
                format!("{p}:0")
            };
            let mut offset = 0;
            let mut roots = Vec::new();
            let mut segments = 0;
            loop {
                let start = std::time::Instant::now();
                let loaded = call(&f, &opened, "large.scene", json!({"key":key,"offset":offset}));
                let range = &loaded["pageRange"];
                assert_eq!(range["offset"], offset);
                assert_eq!(range["totalRoots"], expected);
                assert!(loaded["bytes"].as_u64().unwrap() <= futureox_design_kernel::capacity::document_byte_limit() as u64);
                {
                    let slot = f.sessions.current.lock().unwrap();
                    let doc = &slot.as_ref().unwrap().scene.as_ref().unwrap().document;
                    assert_eq!(doc.pages[0].children.len(), range["end"].as_u64().unwrap() as usize - offset);
                    roots.extend(doc.pages[0].children.clone());
                }
                println!("page={name} range={range} nodes={} bytes={} seconds={:.6}", loaded["nodes"], loaded["bytes"], start.elapsed().as_secs_f64());
                segments += 1;
                match range["nextOffset"].as_u64() { Some(next) => offset = next as usize, None => break }
            }
            assert_eq!(roots.len(), expected);
            assert_eq!(roots.iter().collect::<HashSet<_>>().len(), expected);
            println!("complete page={name} segments={segments} roots={}", roots.len());
        }
    }
    #[test]
    #[ignore = "real source page conversion timing and model oracle"]
    fn actual_source_page_load_measurement() {
        let f = Fixture::new();
        f.open(PathBuf::from(std::env::var("CORE_LARGE_SKETCH_INPUT").unwrap()));
        let slot = f.sessions.current.lock().unwrap();
        let s = slot.as_ref().unwrap();
        let names = std::env::var("CORE_SOURCE_PAGES").unwrap_or("控件,深色,浅色".into());
        for name in names.split(',') {
            let p = s.parts.iter().position(|p| p.index.entries.first().is_some_and(|e| e.kind == "page" && e.name == name)).unwrap();
            for round in 0..2 {
                let start = std::time::Instant::now();
                match scene::build(s, p, 0, &AtomicBool::new(false)) {
                    Ok((document, warnings)) => {
                        let seconds = start.elapsed().as_secs_f64();
                        let bytes = serde_json::to_vec(&document).unwrap();
                        println!("page={name} round={round} seconds={seconds:.6} roots={} nodes={} bytes={} warnings={}", document.pages[0].children.len(), document.nodes.len(), bytes.len(), warnings.len());
                        if let Ok(dir) = std::env::var("CORE_SOURCE_MEASUREMENT_OUTPUT") {
                            fs::create_dir_all(&dir).unwrap();
                            fs::write(PathBuf::from(&dir).join(format!("{name}.json")), &bytes).unwrap();
                        }
                    }
                    Err(error) => println!("page={name} round={round} seconds={:.6} ERROR={error}", start.elapsed().as_secs_f64()),
                }
            }
        }
    }
    #[test]
    #[ignore = "real Sketch bounded page-conversion measurement"]
    fn actual_topology_page_conversion_windows() {
        let f = Fixture::new();
        f.open(PathBuf::from(std::env::var("CORE_LARGE_SKETCH_INPUT").unwrap()));
        let slot = f.sessions.current.lock().unwrap();
        let s = slot.as_ref().unwrap();
        let mut results = Vec::new();
        for (p, part) in s.parts.iter().enumerate().filter(|(_, p)| p.name.starts_with("pages/")) {
            let layers = part.index.entry(0, &s.directory).unwrap().fields.into_iter().find(|f| f.key == "layers").unwrap().value;
            for (n, entry) in part.index.entries.iter().enumerate().filter(|(_, e)| e.parent == Some(0) && e.span.start >= layers.start && e.span.end <= layers.end) {
                let start = std::time::Instant::now();
                let (doc, _) = match projection::sketch_window(s, p, n, 64 * 1024 * 1024) {
                    Ok(doc) => doc,
                    Err(e) => { println!("page-window {p}:{n} FAILED: {e}"); results.push(json!({"key":format!("{p}:{n}"),"sourceBytes":entry.span.len(),"error":e.to_string()})); continue; }
                };
                let json = serde_json::to_vec(&doc).unwrap();
                if let Ok(directory) = std::env::var("CORE_PAGE_WINDOW_OUTPUT") { fs::create_dir_all(&directory).unwrap(); fs::write(PathBuf::from(directory).join(format!("{p}-{n}.json")), &json).unwrap(); }
                println!("page-window {p}:{n} source={} model={} nodes={} elapsed={:.3}", entry.span.len(), json.len(), doc.nodes.len(), start.elapsed().as_secs_f64());
                results.push(json!({"key":format!("{p}:{n}"),"sourceBytes":entry.span.len(),"modelBytes":json.len(),"nodes":doc.nodes.len(),"seconds":start.elapsed().as_secs_f64()}));
            }
        }
        if let Ok(path) = std::env::var("CORE_PAGE_MEASUREMENT") { fs::write(path, serde_json::to_vec_pretty(&results).unwrap()).unwrap(); }
    }
    #[test]
    #[ignore = "explicit user-owned Sketch disk/index/JSON/canvas-codec/export/reopen acceptance"]
    fn actual_topology_sketch_json_and_canvas_edits_export_all_members() {
        let source = PathBuf::from(
            std::env::var("CORE_LARGE_SKETCH_INPUT").expect("Set the user-owned Sketch input"),
        );
        let f = Fixture::new();
        let status = f.open(source.clone());
        println!(
            "real Sketch catalog: expandedBytes={}, indexedObjects={}",
            status["expandedBytes"], status["indexedObjects"]
        );
        let (key, part_name, root_id) = {
            let slot = f.sessions.current.lock().unwrap();
            let s = slot.as_ref().unwrap();
            let (p, part, n, entry) = s
                .parts
                .iter()
                .enumerate()
                .find_map(|(p, part)| {
                    part.index
                        .entries
                        .iter()
                        .enumerate()
                        .find(|(_, e)| e.kind == "rectangle" && e.span.len() < 64 * 1024)
                        .map(|(n, e)| (p, part, n, e))
                })
                .expect("Real rectangle layer");
            (format!("{p}:{n}"), part.name.clone(), entry.id.clone())
        };
        let read = call(&f, &status, "large.read", json!({"key":key}));
        let mut values: BTreeMap<String, Box<RawValue>> =
            serde_json::from_str(read["json"].as_str().unwrap()).unwrap();
        values.insert(
            "name".into(),
            RawValue::from_string(serde_json::to_string("拓扑-JSON校验").unwrap()).unwrap(),
        );
        let status = call(
            &f,
            &status,
            "large.apply",
            json!({"key":key,"json":serde_json::to_string(&values).unwrap(),"expectedHash":read["hash"],"requestId":"real-json-edit"}),
        );
        let projected = call(
            &f,
            &status,
            "large.project",
            json!({"key":key,"workingDocumentId":"00000000-0000-4000-8000-000000000099"}),
        );
        let mut document: futureox_design_kernel::scene::Document =
            serde_json::from_str(projected["json"].as_str().unwrap()).unwrap();
        for page in &document.pages {
            assert_eq!(
                page.id.len(),
                36,
                "Working page ID must satisfy the frontend UUID contract"
            );
            assert!(
                [8, 13, 18, 23]
                    .iter()
                    .all(|offset| page.id.as_bytes()[*offset] == b'-')
            );
        }
        let node = document.nodes.get_mut(&root_id).unwrap();
        node.name = "拓扑-画布校验".into();
        node.transform.0[4] += 3.5;
        document.validate().unwrap();
        // Browser JSON.stringify uses integer notation for whole-valued f64s.
        fn browser_numbers(value: &mut Value) {
            match value {
                Value::Number(n) => {
                    if let Some(f) = n.as_f64() {
                        if f.fract() == 0. && f.abs() <= 9_007_199_254_740_991. {
                            *value = json!(f as i64);
                        }
                    }
                }
                Value::Array(a) => a.iter_mut().for_each(browser_numbers),
                Value::Object(o) => o.values_mut().for_each(browser_numbers),
                _ => {}
            }
        }
        let mut browser_document = serde_json::to_value(&document).unwrap();
        browser_numbers(&mut browser_document);
        let status = call(
            &f,
            &status,
            "large.commitCanvas",
            json!({"key":key,"json":serde_json::to_string(&browser_document).unwrap(),"requestId":"real-canvas-edit"}),
        );
        let output = f.root.join("topology-edited.sketch");
        call(&f, &status, "large.export", json!({"path":output}));
        let mut before = zip::ZipArchive::new(File::open(&source).unwrap()).unwrap();
        let mut after = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        assert_eq!(before.len(), after.len());
        let mut unchanged = 0;
        fn hash_reader(mut reader: impl Read) -> String {
            let mut hash = Sha256::new();
            let mut bytes = [0u8; 65536];
            loop {
                let n = reader.read(&mut bytes).unwrap();
                if n == 0 {
                    break;
                }
                hash.update(&bytes[..n]);
            }
            format!("{:x}", hash.finalize())
        }
        for i in 0..before.len() {
            let entry = before.by_index(i).unwrap();
            let name = entry.name().to_string();
            if name == part_name {
                continue;
            }
            assert_eq!(
                hash_reader(entry),
                hash_reader(after.by_name(&name).unwrap()),
                "Unchanged member: {name}"
            );
            unchanged += 1;
        }
        let edited = DiskIndex::build(
            after.by_name(&part_name).unwrap(),
            MAX_EXPANDED_BYTES,
            &f.root,
        )
        .unwrap();
        assert_eq!(
            edited
                .entries
                .iter()
                .find(|e| e.id == root_id)
                .unwrap()
                .name,
            "拓扑-画布校验"
        );
        call(&f, &status, "large.close", json!({}));
        let reopened = f.open(output);
        assert_eq!(
            reopened["indexedObjects"], status["indexedObjects"],
            "Source index must have identical object admission after reopening"
        );
        println!(
            "real Sketch acceptance: JSON property edit + existing canvas codec edit; {} unchanged archive members byte-identical after decompression; full export reopened",
            unchanged
        );
    }
}
