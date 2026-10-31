//! Diagnostic only. Count requested live Rust allocations, not RSS or GPU bytes.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
pub struct CountingSystem;
pub fn live() -> usize { LIVE.load(Ordering::Relaxed) }
pub fn reset_peak() { PEAK.store(live(),Ordering::Relaxed); }
pub fn peak() -> usize { PEAK.load(Ordering::Relaxed) }
fn added(bytes:usize) { let now=LIVE.fetch_add(bytes,Ordering::Relaxed)+bytes;PEAK.fetch_max(now,Ordering::Relaxed); }
// SAFETY: Every operation forwards the original pointer/layout to System.
// Counters never inspect allocated memory, allocate recursively, or change
// allocation alignment/lifetime. Failed allocations leave accounting intact.
unsafe impl GlobalAlloc for CountingSystem {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() { added(layout.size()); }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() { added(layout.size()); }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(p, layout, size) };
        if !result.is_null() {
            if size >= layout.size() { added(size-layout.size()); }
            else { LIVE.fetch_sub(layout.size()-size, Ordering::Relaxed); }
        }
        result
    }
}
