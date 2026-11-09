//! Animation bake sessions: validate inputs, cache versioned clip data and
//! return owned handles for playback sampling.

//! Smart Animate bake track: in-flight mutual exclusion and the baked-plan
//! result cache.
//!
//! This is the kernel's minimal closed loop of the engine's *baked* Smart
//! Animate track:
//!
//! - **In-flight exclusion** (bake acquire / release): bakes are mutually
//!   exclusive per frame pair. A new bake scans the in-flight set and
//!   conflicts when *any* endpoint of the new pair equals *any* endpoint of
//!   an in-flight pair — a 4-way comparison over `(frameId, generation)`
//!   references (the engine packs them into one i64; see `SaFrameRef` for
//!   our adaptation). A conflict returns a structured error value with the
//!   message *"A bake in flight already uses the start or destination
//!   frame"* — never a panic. Acquire and release are symmetric; here
//!   `SaBakeGuard`'s `Drop` is the release counterpart.
//! - **Result cache** (computeSmartAnimateTrackGroups): baked plans are
//!   cached per frame pair and validated by a 12-byte `{lo, hi, flag}`
//!   version triple compared for equality — a light version check,
//!   deliberately not a content hash; a mismatch invalidates the entry and
//!   the plan is rebuilt.
//!
//! Adaptations:
//! - frames here are string node ids and the "generation" is the
//!   caller-supplied document revision (the editing layer's monotonic
//!   counter), so references stay `(id, generation)` pairs compared on both
//!   halves but cannot pack into a single `i64` the way u32 ids do;
//! - the cache key is an explicit typed tuple, and values are strong `Arc`
//!   handles with a plain bound and FIFO eviction.
use crate::animation_plan::PlanTree;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

const BAKE_CONFLICT_KIND: u32 = 2;
const BAKE_CONFLICT_TAG: &str = "bake";
/// The engine's exact conflict message
/// (`FGSmartAnimateTransitionBake.cpp:189`).
const BAKE_CONFLICT_MESSAGE: &str =
    "A bake in flight already uses the start or destination frame";

/// Lock a registry/cache mutex, recovering a poisoned lock deliberately: the
/// guarded state is a plain set whose mutations are panic-safe, and letting
/// an unrelated earlier panic wedge the lock would leave the in-flight set
/// populated forever (rejecting every overlapping bake). The original panic
/// is not hidden — it already unwound the caller that caused it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A frame reference participating in a bake: node id plus edit generation.
///
/// The engine's counterpart packs `(frameId:u32, generation:u32)` into one
/// `i64`; comparison semantics are identical here —
/// both halves must match — but our frame ids are arbitrary-length strings,
/// so no i64 packing exists. A revision bump on the document stands in for
/// the engine's per-frame generation counter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaFrameRef {
    pub frame_id: String,
    pub generation: u64,
}

impl SaFrameRef {
    pub fn new(frame_id: impl Into<String>, generation: u64) -> Self {
        SaFrameRef {
            frame_id: frame_id.into(),
            generation,
        }
    }
}

impl fmt::Display for SaFrameRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}#gen{}", self.frame_id, self.generation)
    }
}

#[derive(Clone, Debug)]
struct InFlightBake {
    /// Monotonic acquisition token; release removes by token so a guard can
    /// only ever remove its own registration.
    token: u64,
    start: SaFrameRef,
    dest: SaFrameRef,
}

#[derive(Default, Debug)]
struct RegistryState {
    in_flight: Vec<InFlightBake>,
    next_token: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BakeConflict {
    /// The engine's error kind for bake conflicts (`2`).
    pub kind: u32,
    /// The engine's error tag (`"bake"`).
    pub tag: &'static str,
    pub source_file: &'static str,
    /// Source line of the conflict detection.
    pub line: u32,
    /// The engine's exact message.
    pub message: &'static str,
    /// The frame pair the new bake requested.
    pub requested: (SaFrameRef, SaFrameRef),
    /// The already in-flight frame pair it collided with.
    pub in_flight: (SaFrameRef, SaFrameRef),
}

impl fmt::Display for BakeConflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{} [{}#{}]: {} (requested {} -> {}; in flight {} -> {})",
            self.source_file,
            self.line,
            self.tag,
            self.kind,
            self.message,
            self.requested.0,
            self.requested.1,
            self.in_flight.0,
            self.in_flight.1
        )
    }
}

impl std::error::Error for BakeConflict {}

/// Registration held while a bake is live. Dropping it releases the frame
/// pair — the `cleanupBakedSmartAnimateTransition` counterpart — so the
/// acquire/release pair stays symmetric even on early returns.
pub struct SaBakeGuard {
    state: Arc<Mutex<RegistryState>>,
    token: u64,
    start: SaFrameRef,
    dest: SaFrameRef,
}

impl SaBakeGuard {
    /// The frame pair this guard keeps in flight.
    pub fn frame_pair(&self) -> (&SaFrameRef, &SaFrameRef) {
        (&self.start, &self.dest)
    }
}

impl fmt::Debug for SaBakeGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SaBakeGuard")
            .field("token", &self.token)
            .field("start", &self.start)
            .field("dest", &self.dest)
            .finish()
    }
}

impl Drop for SaBakeGuard {
    fn drop(&mut self) {
        lock(&self.state)
            .in_flight
            .retain(|entry| entry.token != self.token);
    }
}

/// The in-flight bake registry: a shared set of frame pairs being baked.
///
/// Mirrors the engine's global in-flight list: a new
/// bake conflicts when any of its two endpoints matches any endpoint of an
/// in-flight bake. Cloning shares the same underlying set, so a host can
/// hand the registry to several preview surfaces and they exclude each other
/// exactly like bakes inside one engine instance.
#[derive(Clone, Default, Debug)]
pub struct SaBakeRegistry {
    state: Arc<Mutex<RegistryState>>,
}

impl SaBakeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a bake over `(from_frame_id, from_rev) -> (to_frame_id,
    /// to_rev)`. Returns the release guard, or a structured conflict when any
    /// endpoint collides with an in-flight bake.
    pub fn begin_bake(
        &self,
        from_frame_id: &str,
        from_rev: u64,
        to_frame_id: &str,
        to_rev: u64,
    ) -> Result<SaBakeGuard, BakeConflict> {
        self.begin_bake_for(
            SaFrameRef::new(from_frame_id, from_rev),
            SaFrameRef::new(to_frame_id, to_rev),
        )
    }

    pub fn begin_bake_for(
        &self,
        start: SaFrameRef,
        dest: SaFrameRef,
    ) -> Result<SaBakeGuard, BakeConflict> {
        let mut state = lock(&self.state);
        // Conflict <=> (in-flight start == new start) OR (in-flight start ==
        // new dest) OR (in-flight dest == new start) OR (in-flight dest ==
        // new dest), comparing (id, generation) on both halves.
        for entry in &state.in_flight {
            if entry.start == start
                || entry.start == dest
                || entry.dest == start
                || entry.dest == dest
            {
                return Err(BakeConflict {
                    kind: BAKE_CONFLICT_KIND,
                    tag: BAKE_CONFLICT_TAG,
                    source_file: file!(),
                    line: line!(),
                    message: BAKE_CONFLICT_MESSAGE,
                    requested: (start, dest),
                    in_flight: (entry.start.clone(), entry.dest.clone()),
                });
            }
        }
        state.next_token += 1;
        let token = state.next_token;
        state.in_flight.push(InFlightBake {
            token,
            start: start.clone(),
            dest: dest.clone(),
        });
        Ok(SaBakeGuard {
            state: Arc::clone(&self.state),
            token,
            start,
            dest,
        })
    }

    /// Number of currently in-flight bakes (diagnostic).
    pub fn in_flight_len(&self) -> usize {
        lock(&self.state).in_flight.len()
    }
}

/// Cache slot identity: the frame pair being transitioned. This is our
/// analogue of the engine's `$$SMART_TRACK_GROUP_CACHE$$:` named slot — an
/// explicit typed tuple instead of a prefixed string key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SaPlanCacheKey {
    pub from_frame_id: String,
    pub to_frame_id: String,
}

impl SaPlanCacheKey {
    pub fn new(from_frame_id: impl Into<String>, to_frame_id: impl Into<String>) -> Self {
        SaPlanCacheKey {
            from_frame_id: from_frame_id.into(),
            to_frame_id: to_frame_id.into(),
        }
    }
}

/// The 12-byte `{lo, hi, flag}` version triple the engine compares for
/// equality to validate a cached track group (equal = hit, unequal =
/// invalidate and rebuild). This is a *light version check, not a content
/// hash*.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SaVersionTriple {
    pub lo: u32,
    pub hi: u32,
    pub flag: u32,
}

impl SaVersionTriple {
    pub const fn from_parts(lo: u32, hi: u32, flag: u32) -> Self {
        SaVersionTriple { lo, hi, flag }
    }

    /// Split a monotonic document revision across `lo`/`hi` (`flag` = 0) —
    /// the "light triple instead of a full revision" recipe: the revision
    /// counter lives inside the triple, exactly where the engine keeps its
    /// generations. Theoretical ABA after 2^32 revisions with matching `lo`
    /// is the accepted trade-off of light validation.
    pub const fn from_revision(revision: u64) -> Self {
        SaVersionTriple {
            lo: (revision & 0xffff_ffff) as u32,
            hi: (revision >> 32) as u32,
            flag: 0,
        }
    }
}

/// Bake-cache telemetry, aligned with the engine's three-axis culture
/// (`_bakedCacheHits` / `_bakedCacheLookups` / `_bakedCacheMisses`).
/// In the proto wasm those counters are dead code (PROTO-ENGINE errata:
/// increments suspected in the native build); here they actually advance.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaBakeCacheStats {
    pub hits: u64,
    pub lookups: u64,
    pub misses: u64,
}

#[derive(Clone, Debug)]
struct SaPlanCacheSlot {
    key: SaPlanCacheKey,
    version: SaVersionTriple,
    plan: Arc<PlanTree>,
}

#[derive(Clone, Debug, Default)]
struct SaPlanCacheState {
    slots: Vec<SaPlanCacheSlot>,
    stats: SaBakeCacheStats,
}

/// Default slot bound. A prototype transition touches one frame pair at a
/// time and a preview alternates among a handful, while each cached plan is
/// O(subtree node count) — a small entry bound caps worst-case memory
/// without touching realistic hit rates.
pub const DEFAULT_SA_PLAN_CACHE_CAPACITY: usize = 16;

/// The baked-plan result cache: named frame-pair slots validated by version
/// triple. Cloning shares the same slots and counters.
#[derive(Clone, Debug)]
pub struct SaPlanCache {
    state: Arc<Mutex<SaPlanCacheState>>,
    capacity: usize,
}

impl Default for SaPlanCache {
    fn default() -> Self {
        SaPlanCache::new(DEFAULT_SA_PLAN_CACHE_CAPACITY)
    }
}

impl SaPlanCache {
    /// Create a cache holding at most `capacity` plans (at least one).
    pub fn new(capacity: usize) -> Self {
        SaPlanCache {
            state: Arc::new(Mutex::new(SaPlanCacheState::default())),
            capacity: capacity.max(1),
        }
    }

    pub fn lookup(&self, key: &SaPlanCacheKey, version: SaVersionTriple) -> Option<Arc<PlanTree>> {
        let mut state = lock(&self.state);
        state.stats.lookups += 1;
        match state.slots.iter().position(|slot| &slot.key == key) {
            Some(index) if state.slots[index].version == version => {
                state.stats.hits += 1;
                Some(Arc::clone(&state.slots[index].plan))
            }
            Some(index) => {
                state.slots.remove(index);
                state.stats.misses += 1;
                None
            }
            None => {
                state.stats.misses += 1;
                None
            }
        }
    }

    /// Store a baked plan for the frame pair under `version`. Re-inserting
    /// an existing key replaces its plan and version in place (FIFO order is
    /// preserved); a fresh key evicts the oldest insertion past capacity.
    pub fn insert(&self, key: SaPlanCacheKey, version: SaVersionTriple, plan: Arc<PlanTree>) {
        let mut state = lock(&self.state);
        if let Some(slot) = state.slots.iter_mut().find(|slot| slot.key == key) {
            slot.version = version;
            slot.plan = plan;
            return;
        }
        while state.slots.len() >= self.capacity {
            state.slots.remove(0);
        }
        state.slots.push(SaPlanCacheSlot { key, version, plan });
    }

    /// The three-axis counters (`_bakedCacheHits/Lookups/Misses`).
    pub fn stats(&self) -> SaBakeCacheStats {
        lock(&self.state).stats
    }

    /// Number of resident slots (diagnostic).
    pub fn len(&self) -> usize {
        lock(&self.state).slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        let mut state = lock(&self.state);
        state.slots.clear();
        state.stats = SaBakeCacheStats::default();
    }
}

/// A completed bake: the (possibly cached) plan plus the guard that keeps
/// the frame pair registered as in flight. Drop the value — or just its
/// [`SaBakeGuard`] — to release the pair.
pub struct SaBakedPlan {
    pub plan: Arc<PlanTree>,
    pub guard: SaBakeGuard,
}

impl fmt::Debug for SaBakedPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SaBakedPlan")
            .field("plan", &"Arc<PlanTree>")
            .field("guard", &self.guard)
            .finish()
    }
}

/// The bake-track context: one shared in-flight registry plus one result
/// cache. Clones share both, so independent entry points still exclude each
/// other and see each other's cached plans.
#[derive(Clone, Default, Debug)]
pub struct SaBakeContext {
    pub registry: SaBakeRegistry,
    pub cache: SaPlanCache,
}

impl SaBakeContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// A context whose cache holds at most `capacity` plans.
    pub fn with_cache_capacity(capacity: usize) -> Self {
        SaBakeContext {
            registry: SaBakeRegistry::new(),
            cache: SaPlanCache::new(capacity),
        }
    }
}

/// Sampling state of a live session: the snapshot the plan was baked from
/// plus the baked plan whose guard keeps the frame pair in flight.
#[derive(Debug)]
struct SaBakedSample {
    document: crate::scene::Document,
    from: String,
    to: String,
    plan: SaBakedPlan,
}

/// One-bake-many-samples session over a [`SaBakeContext`]: the stateful core
/// behind the wasm `AnimationBakeSession` binding. Holds the bake context
/// (shared in-flight registry + result cache) and at most one live
/// [`SaBakedPlan`]; re-baking replaces the previous plan, and dropping the
/// session drops the guard, releasing the frame pair — the symmetric
/// acquire/release loop the engine runs per prototype transition.
///
/// Sampling follows the pure path's single-document contract
/// ([`PlanTree::sample_document`]): the held snapshot is expected to contain
/// both sides of the pair, exactly as the stateless `sample_document` entry
/// requires of its one document argument.
#[derive(Debug, Default)]
pub struct SaBakeSession {
    context: SaBakeContext,
    baked: Option<SaBakedSample>,
}

impl SaBakeSession {
    /// A session with its own private registry and cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// A session over a shared context (clones share registry and cache), so
    /// several sessions can exclude each other's in-flight pairs and serve
    /// each other's cached plans.
    pub fn with_context(context: SaBakeContext) -> Self {
        SaBakeSession {
            context,
            baked: None,
        }
    }

    /// The shared context (diagnostics, cache stats).
    pub fn context(&self) -> &SaBakeContext {
        &self.context
    }

    /// Register and bake `(old_root, revision) -> (new_root, revision)`.
    ///
    /// The previous plan — and with it its in-flight guard — is dropped
    /// *before* the new bake registers: the registry compares on `(id,
    /// generation)`, so re-baking the same pair at the same revision would
    /// otherwise collide with the session's own still-live registration.
    /// That also means a failed bake (a conflict with another live session)
    /// leaves the session with no plan.
    pub fn bake(
        &mut self,
        old_doc: &crate::scene::Document,
        new_doc: &crate::scene::Document,
        old_root: &str,
        new_root: &str,
        revision: u64,
    ) -> Result<(), BakeConflict> {
        self.baked = None;
        let plan = PlanTree::bake(old_doc, new_doc, old_root, new_root, &self.context, revision)?;
        self.baked = Some(SaBakedSample {
            document: new_doc.clone(),
            from: old_root.to_string(),
            to: new_root.to_string(),
            plan,
        });
        Ok(())
    }

    /// Sample the held plan at `progress` — the per-frame tick served without
    /// a rebuild ([`PlanTree::sample_document_with_plan`]). Errors when no
    /// bake has happened (or the last bake failed).
    pub fn sample(&self, progress: f64) -> Result<crate::scene::Document, String> {
        let baked = self
            .baked
            .as_ref()
            .ok_or_else(|| "No baked animation plan; call bake first".to_string())?;
        PlanTree::sample_document_with_plan(
            &baked.document,
            &baked.from,
            &baked.to,
            progress,
            &baked.plan.plan,
        )
    }

    /// The cache telemetry of the session's context (hits/lookups/misses).
    pub fn stats(&self) -> SaBakeCacheStats {
        self.context.cache.stats()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_triple_packs_a_revision_counter() {
        let triple = SaVersionTriple::from_revision(0x0000_0001_2345_6789);
        assert_eq!(triple.lo, 0x2345_6789);
        assert_eq!(triple.hi, 0x0000_0001);
        assert_eq!(triple.flag, 0);
        assert_eq!(SaVersionTriple::from_revision(u64::MAX).lo, u32::MAX);
        assert_eq!(SaVersionTriple::from_revision(u64::MAX).hi, u32::MAX);
        assert_ne!(
            SaVersionTriple::from_revision(1),
            SaVersionTriple::from_revision(2)
        );
    }

    #[test]
    fn conflict_error_carries_source_location_and_both_pairs() {
        let registry = SaBakeRegistry::new();
        let _guard = registry.begin_bake("a", 1, "b", 1).unwrap();
        let conflict = registry.begin_bake("b", 1, "c", 1).unwrap_err();
        assert_eq!(conflict.kind, 2);
        assert_eq!(conflict.tag, "bake");
        assert_eq!(
            conflict.message,
            "A bake in flight already uses the start or destination frame"
        );
        assert!(conflict.source_file.ends_with("animation_bake.rs"));
        assert!(conflict.line > 0);
        assert_eq!(conflict.requested.0.frame_id, "b");
        assert_eq!(conflict.requested.1.frame_id, "c");
        assert_eq!(conflict.in_flight.0.frame_id, "a");
        assert_eq!(conflict.in_flight.1.frame_id, "b");
        let text = conflict.to_string();
        assert!(text.contains("animation_bake.rs"));
        assert!(text.contains("in flight a#gen1 -> b#gen1"));
    }
}
