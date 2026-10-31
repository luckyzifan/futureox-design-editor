//! Bounded second-chance cache. Callers hold a shared RwLock for hits and an
//! exclusive lock for insertion/eviction. Hits never allocate or mutate the
//! lookup/order tables; relaxed atomics only track eviction hints and stats.
use std::{borrow::Borrow, collections::{HashMap, VecDeque}, hash::Hash,
    sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}}};

struct Entry<V> { value: Arc<V>, recent: AtomicBool, bytes: usize }
pub(crate) struct ReadCache<K, V> {
    entries: HashMap<K, Entry<V>>,
    order: VecDeque<K>,
    bytes: usize,
    hits: AtomicU64,
    limit: usize,
    capacity: usize,
}
impl<K: Eq + Hash + Clone, V> ReadCache<K, V> {
    pub fn new(limit: usize, capacity: usize) -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new(), bytes: 0,
            hits: AtomicU64::new(0), limit, capacity }
    }
    pub fn get<Q: Eq + Hash + ?Sized>(&self, key: &Q) -> Option<Arc<V>> where K: Borrow<Q> {
        let entry = self.entries.get(key)?;
        entry.recent.store(true, Ordering::Relaxed);
        self.hits.fetch_add(1, Ordering::Relaxed);
        Some(entry.value.clone())
    }
    pub fn insert(&mut self, key: K, value: V, bytes: usize) -> Arc<V> {
        // A second worker may have built the same value outside the write lock.
        if let Some(existing) = self.get(&key) { return existing; }
        let value = Arc::new(value);
        if bytes > self.limit || self.capacity == 0 { return value; }
        while self.bytes + bytes > self.limit || self.entries.len() >= self.capacity {
            let Some(old) = self.order.pop_front() else { break; };
            let entry = self.entries.get(&old).expect("cache order contains a resident key");
            if entry.recent.swap(false, Ordering::Relaxed) {
                self.order.push_back(old);
            } else {
                self.bytes -= self.entries.remove(&old).unwrap().bytes;
            }
        }
        self.bytes += bytes;
        self.order.push_back(key.clone());
        self.entries.insert(key, Entry { value: value.clone(), recent: AtomicBool::new(false), bytes });
        value
    }
    pub fn stats(&self) -> serde_json::Value {
        serde_json::json!({"hits":self.hits.load(Ordering::Relaxed),"entries":self.entries.len(),"bytes":self.bytes,"limit":self.limit})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::RwLock;
    #[test]
    fn shared_hits_preserve_values_and_bounded_eviction() {
        let mut cache = ReadCache::new(4, 4);
        let first = cache.insert(0, vec![0], 1);
        for i in 1..4 { cache.insert(i, vec![i], 1); }
        let cache = Arc::new(RwLock::new(cache));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let cache = &cache; let first = &first;
                scope.spawn(move || for _ in 0..1000 {
                    assert!(Arc::ptr_eq(&cache.read().unwrap().get(&0).unwrap(), first));
                });
            }
        });
        let mut cache = cache.write().unwrap();
        assert_eq!(cache.stats()["hits"], 8000);
        cache.insert(4, vec![4], 1);
        assert!(cache.get(&0).is_some()); assert!(cache.get(&1).is_none());
        assert!(Arc::ptr_eq(&cache.insert(0, vec![99], 1), &first));
        let oversized = cache.insert(9, vec![9], 5);
        assert_eq!(*oversized, vec![9]); assert!(cache.get(&9).is_none());
        cache.insert(5, vec![5], 4);
        assert_eq!(cache.stats()["entries"], 1); assert_eq!(cache.stats()["bytes"], 4);
        assert_eq!(*first, vec![0], "eviction cannot invalidate a borrowed outline");
    }
}
