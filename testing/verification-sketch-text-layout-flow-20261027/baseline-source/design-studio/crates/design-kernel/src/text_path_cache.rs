//! Exact local text outlines for one immutable font-resource set. Layout input
//! bytes are complete keys; placement, node ID and paint are intentionally absent.
use crate::{path::Path, read_cache::ReadCache};
use std::sync::Arc;
pub(crate) struct Cache { inner: ReadCache<Arc<[u8]>, Path> }
impl Default for Cache {
    fn default() -> Self { Self { inner: ReadCache::new(16 * 1024 * 1024, 2048) } }
}
impl Cache {
    pub fn get(&self, key: &[u8]) -> Option<Arc<Path>> { self.inner.get(key) }
    pub fn insert(&mut self, key: Vec<u8>, path: Path) -> Arc<Path> {
        if let Some(existing) = self.get(&key) { return existing; }
        let bytes = key.capacity() + key.len() + path.commands.capacity() * std::mem::size_of::<crate::path::Command>() + 256;
        if key.len() > 65536 { return Arc::new(path); }
        self.inner.insert(key.into(), path, bytes)
    }
    pub fn stats(&self) -> serde_json::Value { self.inner.stats() }
}
