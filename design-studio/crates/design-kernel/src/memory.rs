//! CPU compositor buffer accounting. Geometry, decoded assets and encoded output
//! have separate admission limits; this is not a process RSS limit.
use std::sync::{Arc, Mutex};

pub(crate) const COMPOSITING_BYTES: usize = 256 * 1024 * 1024;
const SURFACE_WORK_PIXELS: usize = 200_000_000;

#[derive(Default, Clone, Copy)]
pub(crate) struct Usage {
    pub live_bytes: usize,
    pub peak_bytes: usize,
    pub live_surface_pixels: usize,
    pub peak_surface_pixels: usize,
    pub allocated_surface_pixels: usize,
    /// Budget rejections — Figma's `clearErrorsAndCheckForOOM` counterpart:
    /// pressure stays observable after the failed render returns.
    pub rejections: u32,
    pub last_rejection_requested_bytes: usize,
    pub last_rejection_live_bytes: usize,
}

#[derive(Clone)]
pub(crate) struct Budget {
    state: Arc<Mutex<Usage>>,
    limit: usize,
}

impl Budget {
    pub fn new(limit: usize) -> Self {
        Self {
            state: Arc::default(),
            limit,
        }
    }

    pub fn reserve(
        &self,
        count: usize,
        element_bytes: usize,
        surface: bool,
    ) -> Result<Allocation, String> {
        let error = || "Compositing memory budget exceeded".to_string();
        let bytes = count.checked_mul(element_bytes).ok_or_else(error)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Compositing budget lock poisoned")?;
        let live = state.live_bytes.checked_add(bytes).ok_or_else(error)?;
        if live > self.limit {
            state.rejections += 1;
            state.last_rejection_requested_bytes = bytes;
            state.last_rejection_live_bytes = state.live_bytes;
            return Err(error());
        }
        let pixels = if surface { count } else { 0 };
        let allocated = state
            .allocated_surface_pixels
            .checked_add(pixels)
            .filter(|n| *n <= SURFACE_WORK_PIXELS)
            .ok_or("Frame compositing work budget exceeded")?;
        state.live_bytes = live;
        state.peak_bytes = state.peak_bytes.max(live);
        state.live_surface_pixels += pixels;
        state.peak_surface_pixels = state.peak_surface_pixels.max(state.live_surface_pixels);
        state.allocated_surface_pixels = allocated;
        Ok(Allocation {
            budget: self.clone(),
            bytes,
            pixels,
        })
    }

    pub fn usage(&self) -> Usage {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// One reservation per owned buffer. Arc<Surface> clones share its reservation;
/// copying pixel storage requires a separate fallible reservation.
pub(crate) struct Allocation {
    pub budget: Budget,
    bytes: usize,
    pixels: usize,
}
impl Drop for Allocation {
    fn drop(&mut self) {
        let mut state = self.budget.state.lock().unwrap_or_else(|e| e.into_inner());
        state.live_bytes -= self.bytes;
        state.live_surface_pixels -= self.pixels;
    }
}

// ---------------------------------------------------------------------------
// GPU memory ledger — Figma's four `CorePerfInfo` i64 counters
// (VRAM-LEDGER-RESOLVED.md task A: addresses 5246784/5246792/5246800/5246808).
//
// Figma's shape: every backend resource constructor does a read-modify-write
// `+bytes` on exactly one global counter, every destructor `-bytes`, plus a
// separate high-water mark kept with `max(old, sum)` at the texture creation
// sites. The four counters sum to the renderer's GPU memory total
// (`FullscreenPerfInfo::getRendererGpuMemory`, wasm func#46443) and the same
// sum drives the CanvasView memory-pressure decision (`needs_free` /
// `FREE_CACHED_DATA`, wasm func#39291).
//
// Our resource model is not isomorphic to Figma's two backends; the bucket
// mapping is recorded per category below and in
// figma-wasm-analysis/impl-2026-10-16/E6-VRAM-LEDGER.md. Deviation: Figma's
// counters are process-global i64s mutated non-atomically; ours is one
// shared mutex-guarded ledger (clone = same state) with saturating frees.
// ---------------------------------------------------------------------------

/// One of Figma's four renderer-memory buckets, mapped to our resources.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuMemoryCategory {
    /// Figma counter 5246784 (textureMemStats bytes): swapchain/render
    /// textures, size = format bytes x width x height. Ours: every wgpu
    /// `Texture` this process creates (vector layer targets, the blank 1x1
    /// sentinel, device-resident decoded images).
    Texture,
    /// Figma counter 5246792 (rendererMemStats category 1): lazily created
    /// GPU buffer objects sized by a byte field. Ours: the frame uniform
    /// arena (the only wgpu `Buffer` without element-count semantics).
    Buffer,
    /// Figma counter 5246800 (category 3): fixed arrays of 4-byte elements,
    /// counted as count x count x 4 (vertex/index-shaped). Ours: the f32
    /// analytic-segment storage buffer and the f32 ordered-instance storage
    /// buffer (bytes = element count x 4).
    FixedArray,
    /// Figma counter 5246808 (category 4): data blobs that keep an explicit
    /// CPU copy (constructor mallocs it). Ours: padded GPU readback buffers
    /// whose mapped range becomes a CPU `Vec` (COPY_DST | MAP_READ).
    Blob,
}

/// Live snapshot of the four buckets plus per-bucket and total high-water
/// marks and pressure bookkeeping.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMemoryUsage {
    pub texture_bytes: u64,
    pub buffer_bytes: u64,
    pub fixed_array_bytes: u64,
    pub blob_bytes: u64,
    pub peak_texture_bytes: u64,
    pub peak_buffer_bytes: u64,
    pub peak_fixed_array_bytes: u64,
    pub peak_blob_bytes: u64,
    /// High-water mark of the four-bucket sum (Figma `dev+2224`, kept with
    /// `i64.gt_u + select` at the texture creation sites).
    pub peak_total_bytes: u64,
    /// Times the `needs_free` decision hook ran the cached-data reclaim
    /// path (Figma `FREE_CACHED_DATA` events, wasm func#39291).
    pub free_events: u32,
    /// Over-limit admission refusals — the observable counterpart of
    /// Figma's "would delta more bytes exceed the limit" query
    /// (wasm #45702/#45914) and of `Usage::rejections` on the CPU budget.
    pub rejections: u32,
    pub last_rejection_requested_bytes: u64,
}

impl GpuMemoryUsage {
    /// The four-bucket sum — Figma's renderer GPU memory total.
    pub fn total_bytes(&self) -> u64 {
        self.texture_bytes
            .saturating_add(self.buffer_bytes)
            .saturating_add(self.fixed_array_bytes)
            .saturating_add(self.blob_bytes)
    }
    fn live_mut(&mut self, category: GpuMemoryCategory) -> &mut u64 {
        match category {
            GpuMemoryCategory::Texture => &mut self.texture_bytes,
            GpuMemoryCategory::Buffer => &mut self.buffer_bytes,
            GpuMemoryCategory::FixedArray => &mut self.fixed_array_bytes,
            GpuMemoryCategory::Blob => &mut self.blob_bytes,
        }
    }
    fn peak_mut(&mut self, category: GpuMemoryCategory) -> &mut u64 {
        match category {
            GpuMemoryCategory::Texture => &mut self.peak_texture_bytes,
            GpuMemoryCategory::Buffer => &mut self.peak_buffer_bytes,
            GpuMemoryCategory::FixedArray => &mut self.peak_fixed_array_bytes,
            GpuMemoryCategory::Blob => &mut self.peak_blob_bytes,
        }
    }
}

/// Default policy limit. Figma derives its limit from an adapter capability
/// query (WebGPU field `[backend+444]`, GL `[[this+32]+188]+96`); wgpu
/// exposes no VRAM byte limit, so this is a fixed admission-policy constant
/// the host may override. 512 MiB comfortably contains the compositor's own
/// 256 MiB surface cap plus the uniform/instance arenas.
pub const DEFAULT_GPU_MEMORY_LIMIT_BYTES: u64 = 512 * 1024 * 1024;

/// Four-bucket GPU memory ledger. `Clone` shares the state, so a native host
/// can install one ledger into both the wgpu device side (which feeds it)
/// and the kernel `Engine` (which exports it).
#[derive(Clone)]
pub struct GpuMemoryLedger {
    state: std::sync::Arc<std::sync::Mutex<GpuMemoryUsage>>,
    limit_bytes: u64,
}

impl Default for GpuMemoryLedger {
    fn default() -> Self {
        Self::new(DEFAULT_GPU_MEMORY_LIMIT_BYTES)
    }
}

impl GpuMemoryLedger {
    pub fn new(limit_bytes: u64) -> Self {
        Self {
            state: std::sync::Arc::default(),
            limit_bytes,
        }
    }

    pub fn limit_bytes(&self) -> u64 {
        self.limit_bytes
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, GpuMemoryUsage> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Constructor hook: `+bytes` on one bucket, then refresh that bucket's
    /// peak and the four-bucket high-water mark (Figma texture-site peak
    /// maintenance, applied uniformly to every bucket here).
    pub fn alloc(&self, category: GpuMemoryCategory, bytes: u64) {
        let mut state = self.lock();
        let live = state.live_mut(category).saturating_add(bytes);
        *state.live_mut(category) = live;
        let peak = state.peak_mut(category);
        *peak = (*peak).max(live);
        let total = state.total_bytes();
        state.peak_total_bytes = state.peak_total_bytes.max(total);
    }

    /// Destructor hook: `-bytes` on one bucket. Figma's i64 subtraction can
    /// go negative on a bookkeeping bug; ours saturates at zero so one
    /// stray free cannot corrupt later accounting (deviation, recorded).
    pub fn free(&self, category: GpuMemoryCategory, bytes: u64) {
        let mut state = self.lock();
        let live = state.live_mut(category);
        *live = live.saturating_sub(bytes);
    }

    /// Figma's pre-allocation query (wasm #45702/#45914):
    /// `(current sum + delta) > limit` — checked before the resource exists.
    pub fn would_exceed(&self, delta_bytes: u64) -> bool {
        self.lock().total_bytes().saturating_add(delta_bytes) > self.limit_bytes
    }

    /// The memory-pressure decision hook (Figma `needs_free`, wasm #39291,
    /// consumed at the CanvasView layer). Pressure is live occupancy; the
    /// historical peak remains telemetry and must not trigger perpetual GC
    /// after a completed reclamation. Admission rejections stay observable.
    pub fn needs_free(&self) -> bool {
        self.lock().total_bytes() >= self.limit_bytes
    }

    /// Record that the cached-data reclaim path actually ran
    /// (`FREE_CACHED_DATA`). Called by the reclaim site, never by callers
    /// that only observed `needs_free`.
    pub fn note_free_event(&self) {
        self.lock().free_events += 1;
    }

    /// Record an over-limit admission refusal (see `would_exceed`).
    pub fn note_rejection(&self, requested_bytes: u64) {
        let mut state = self.lock();
        state.rejections += 1;
        state.last_rejection_requested_bytes = requested_bytes;
    }

    pub fn usage(&self) -> GpuMemoryUsage {
        *self.lock()
    }
}

#[cfg(test)]
mod gpu_ledger_tests {
    use super::*;

    #[test]
    fn four_buckets_count_independently_and_free_back_to_zero() {
        let ledger = GpuMemoryLedger::new(1 << 30);
        ledger.alloc(GpuMemoryCategory::Texture, 400);
        ledger.alloc(GpuMemoryCategory::Buffer, 100);
        ledger.alloc(GpuMemoryCategory::FixedArray, 7 * 4);
        ledger.alloc(GpuMemoryCategory::Blob, 64);
        let usage = ledger.usage();
        assert_eq!(usage.texture_bytes, 400);
        assert_eq!(usage.buffer_bytes, 100);
        assert_eq!(usage.fixed_array_bytes, 28);
        assert_eq!(usage.blob_bytes, 64);
        assert_eq!(usage.total_bytes(), 592);
        ledger.free(GpuMemoryCategory::Texture, 400);
        ledger.free(GpuMemoryCategory::Buffer, 100);
        ledger.free(GpuMemoryCategory::FixedArray, 28);
        ledger.free(GpuMemoryCategory::Blob, 64);
        let usage = ledger.usage();
        assert_eq!(usage.total_bytes(), 0);
        // Frees never touch peaks: the high-water mark survives.
        assert_eq!(usage.peak_total_bytes, 592);
        assert_eq!(usage.peak_texture_bytes, 400);
        assert_eq!(usage.peak_buffer_bytes, 100);
        assert_eq!(usage.peak_fixed_array_bytes, 28);
        assert_eq!(usage.peak_blob_bytes, 64);
    }

    #[test]
    fn peaks_are_monotonic_and_track_the_bucket_max() {
        let ledger = GpuMemoryLedger::new(1 << 30);
        // The fixed array accumulates across rounds (never freed in the
        // loop); its peak after round r is 4*(1+..+r) = 2r(r+1).
        for round in 1..=4u64 {
            ledger.alloc(GpuMemoryCategory::Texture, 100);
            ledger.alloc(GpuMemoryCategory::FixedArray, round * 4);
            ledger.free(GpuMemoryCategory::Texture, 100);
            let usage = ledger.usage();
            assert_eq!(usage.peak_texture_bytes, 100);
            assert_eq!(usage.peak_fixed_array_bytes, 2 * round * (round + 1));
        }
        let usage = ledger.usage();
        assert_eq!(usage.texture_bytes, 0);
        assert_eq!(usage.fixed_array_bytes, 40);
        // Total peak is the maximum simultaneous sum: round 4 had texture
        // 100 + accumulated fixed arrays 40 live together before the free.
        assert_eq!(usage.peak_total_bytes, 100 + 40);
        // Peaks never decrease: a later allocation below the high-water
        // mark raises the live sum but not the peak.
        let before = usage.peak_total_bytes;
        ledger.alloc(GpuMemoryCategory::Blob, 1);
        assert_eq!(ledger.usage().peak_total_bytes, before);
        assert_eq!(ledger.usage().total_bytes(), 41);
    }

    #[test]
    fn saturating_free_cannot_underflow_the_ledger() {
        let ledger = GpuMemoryLedger::new(1 << 30);
        ledger.alloc(GpuMemoryCategory::Texture, 10);
        ledger.free(GpuMemoryCategory::Texture, 10);
        ledger.free(GpuMemoryCategory::Texture, 10);
        assert_eq!(ledger.usage().texture_bytes, 0);
        assert_eq!(ledger.usage().total_bytes(), 0);
    }

    #[test]
    fn needs_free_clears_after_reclamation_without_erasing_peak() {
        let ledger = GpuMemoryLedger::new(1000);
        assert!(!ledger.needs_free());
        ledger.alloc(GpuMemoryCategory::Texture, 900);
        assert!(!ledger.needs_free());
        assert!(ledger.would_exceed(200));
        assert!(!ledger.would_exceed(50));
        // Cross the limit, then reclaim. The peak survives as telemetry;
        // it must not force every subsequent frame to evict its warm caches.
        ledger.alloc(GpuMemoryCategory::Buffer, 200);
        assert!(ledger.needs_free());
        ledger.free(GpuMemoryCategory::Texture, 900);
        ledger.free(GpuMemoryCategory::Buffer, 200);
        assert!(!ledger.needs_free());
        assert_eq!(ledger.usage().peak_total_bytes, 1100);
        ledger.note_free_event();
        assert_eq!(ledger.usage().free_events, 1);
    }

    #[test]
    fn rejections_stay_observable_like_budget_rejections() {
        let ledger = GpuMemoryLedger::new(100);
        ledger.note_rejection(150);
        ledger.note_rejection(75);
        let usage = ledger.usage();
        assert_eq!(usage.rejections, 2);
        assert_eq!(usage.last_rejection_requested_bytes, 75);
    }

    #[test]
    fn clones_share_one_state() {
        let ledger = GpuMemoryLedger::new(1 << 30);
        let shared = ledger.clone();
        ledger.alloc(GpuMemoryCategory::Blob, 32);
        assert_eq!(shared.usage().blob_bytes, 32);
        shared.free(GpuMemoryCategory::Blob, 32);
        assert_eq!(ledger.usage().total_bytes(), 0);
    }
}
