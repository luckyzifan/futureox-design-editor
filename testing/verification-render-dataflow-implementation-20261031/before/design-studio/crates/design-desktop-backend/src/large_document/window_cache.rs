//! Disposable converted source windows. Source revisions and edit baselines
//! remain authoritative; this cache never publishes or owns authored changes.
use super::*;
use futureox_design_kernel::{scene::Document, scene_store};
use std::sync::atomic::AtomicUsize;

#[derive(Clone)]
struct Cached { path: PathBuf, descriptor: scene_store::Descriptor }
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

fn read(entry: &Cached, cancel: &AtomicBool) -> Result<(Document, Vec<String>)> {
    scene_store::Reader::open(&entry.path,&entry.descriptor,cancel)
        .and_then(|reader|reader.into_document(cancel)).map_err(issue)
}
fn write(path: &Path, generation:&str, doc: &Document, warnings: &[String], cancel: &AtomicBool) -> io::Result<Cached> {
    let descriptor=scene_store::write(path,generation,doc,warnings,cancel)?;
    Ok(Cached {path:path.into(),descriptor})
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
    let (document, warnings) = projection::sketch_window_in(s, p, n, 64 * 1024 * 1024, context)?;
    check_cancel(cancel).map_err(issue)?;
    let path = {
        let mut cache = s.converted_windows.lock().map_err(issue)?;
        cache.directory(s).ok().map(|directory|directory.join(format!("{p}-{n}.scene")))
    };
    if let Some(path) = path {
        let generation=format!("{}:{}:{}:{p}:{n}",s.owner.document_id,s.owner.session_epoch,s.revision);
        if let Ok(entry) = write(&path, &generation, &document, &warnings, cancel) {
            s.converted_windows.lock().map_err(issue)?.entries.insert((p,n), entry);
        }
    }
    check_cancel(cancel).map_err(issue)?;
    Ok((document, warnings))
}
