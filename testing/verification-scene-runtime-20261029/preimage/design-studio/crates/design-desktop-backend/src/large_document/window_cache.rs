//! Disposable converted source windows. Source revisions and edit baselines
//! remain authoritative; this cache never publishes or owns authored changes.
use super::*;
use futureox_design_kernel::scene::Document;
use std::sync::atomic::AtomicUsize;

#[derive(Clone)]
struct Cached { path: PathBuf, bytes: u64, hash: String }
#[derive(Default)]
pub(super) struct Windows {
    revision: Option<u64>, directory: Option<PathBuf>, entries: BTreeMap<(usize, usize), Cached>,
    #[cfg(test)] pub hits: usize,
}
impl Windows {
    #[cfg(test)]
    pub fn files(&self) -> Vec<PathBuf> { self.entries.values().map(|entry|entry.path.clone()).collect() }
    fn clear(&mut self) {
        // Remove only files minted by this cache, never a source directory or
        // arbitrary contents introduced by another process.
        for (_, entry) in std::mem::take(&mut self.entries) { let _ = fs::remove_file(entry.path); }
        if let Some(path) = self.directory.take() { let _ = fs::remove_dir(path); }
    }
    fn begin(&mut self, revision: u64) {
        if self.revision != Some(revision) { self.clear(); self.revision = Some(revision); }
    }
    fn directory(&mut self, s: &Session) -> io::Result<&Path> {
        if self.directory.is_none() {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = s.directory.parent().ok_or_else(|| io::Error::other("Source cache has no parent"))?.join(format!(
                "converted-{}-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io::Error::other)?.as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path)?;
            self.directory = Some(path);
        }
        Ok(self.directory.as_deref().unwrap())
    }
}
impl Drop for Windows { fn drop(&mut self) { self.clear(); } }

struct Output<'a> { file: BufWriter<File>, bytes: u64, hash: Sha256, cancel: &'a AtomicBool }
impl Write for Output<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        check_cancel(self.cancel)?;
        let count = self.file.write(bytes)?;
        self.hash.update(&bytes[..count]);
        self.bytes = self.bytes.checked_add(count as u64).ok_or_else(|| io::Error::other("Converted source size overflow"))?;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> { self.file.flush() }
}

fn read(entry: &Cached, cancel: &AtomicBool) -> Result<(Document, Vec<String>)> {
    let metadata = fs::symlink_metadata(&entry.path).map_err(issue)?;
    if !metadata.is_file() || metadata.len() != entry.bytes || hash_file(&entry.path, cancel).map_err(issue)? != entry.hash {
        return Err(issue("Converted source cache changed"));
    }
    let source = CheckedReader { inner: File::open(&entry.path).map_err(issue)?.take(entry.bytes), cancel, progress: None };
    serde_json::from_reader(BufReader::new(source)).map_err(issue)
}
fn write(path: &Path, doc: &Document, warnings: &[String], cancel: &AtomicBool) -> io::Result<Cached> {
    let file = OpenOptions::new().create_new(true).write(true).open(path)?;
    let mut writer = Output { file: BufWriter::new(file), bytes: 0, hash: Sha256::new(), cancel };
    let result = serde_json::to_writer(&mut writer, &(doc, warnings)).map_err(io::Error::other).and_then(|_|writer.flush());
    if let Err(error) = result { drop(writer); let _ = fs::remove_file(path); return Err(error); }
    // Cache persistence is optional. No fsync or durable edit receipt is implied.
    Ok(Cached { path: path.into(), bytes: writer.bytes, hash: format!("{:x}", writer.hash.finalize()) })
}

pub(super) fn convert(s: &Session, p: usize, n: usize, cancel: &AtomicBool, context: &projection::SketchContext) -> Result<(Document, Vec<String>)> {
    check_cancel(cancel).map_err(issue)?;
    let cached = {
        let mut cache = s.converted_windows.lock().map_err(issue)?;
        cache.begin(s.revision);
        cache.entries.get(&(p,n)).cloned()
    };
    if let Some(cached) = cached {
        match read(&cached, cancel) {
            Ok(value) => {
                #[cfg(test)] { s.converted_windows.lock().map_err(issue)?.hits += 1; }
                return Ok(value);
            }
            Err(_) => {
                check_cancel(cancel).map_err(issue)?;
                let mut cache = s.converted_windows.lock().map_err(issue)?;
                cache.entries.remove(&(p,n)); let _ = fs::remove_file(cached.path);
            }
        }
    }
    let (document, _, warnings) = projection::sketch_window_in(s, p, n, 64 * 1024 * 1024, context)?;
    check_cancel(cancel).map_err(issue)?;
    let path = {
        let mut cache = s.converted_windows.lock().map_err(issue)?;
        cache.directory(s).ok().map(|directory|directory.join(format!("{p}-{n}.json")))
    };
    if let Some(path) = path {
        if let Ok(entry) = write(&path, &document, &warnings, cancel) {
            s.converted_windows.lock().map_err(issue)?.entries.insert((p,n), entry);
        }
    }
    check_cancel(cancel).map_err(issue)?;
    Ok((document, warnings))
}
