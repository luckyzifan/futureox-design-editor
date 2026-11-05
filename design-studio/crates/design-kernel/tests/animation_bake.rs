//! Smart Animate bake-track kernel tests: in-flight mutual exclusion, the
//! baked-plan result cache, and their wiring into the PlanTree entry points
//! (bake algorithm spec §4/§5).
use futureox_design_kernel::animation_bake::{
    BakeConflict, SaBakeCacheStats, SaBakeContext, SaBakeRegistry, SaBakeSession, SaPlanCache,
    SaPlanCacheKey, SaVersionTriple,
};
use futureox_design_kernel::animation_plan::PlanTree;
use futureox_design_kernel::facet::sample_node;
use futureox_design_kernel::math::Transform;
use futureox_design_kernel::scene::{Document, Node, Page};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

fn rect(id: &str, name: &str, matrix: [f64; 6]) -> Node {
    let mut n = sample_node(id, "rectangle");
    n.name = name.into();
    n.width = 24.;
    n.height = 16.;
    n.transform = Transform(matrix);
    n.fills = vec![serde_json::from_value(json!({"kind":"solid","color":"#4488cc"})).unwrap()];
    n
}

fn frame(id: &str, children: &[&str], x: f64, y: f64) -> Node {
    let mut n = sample_node(id, "frame");
    n.name = id.into();
    n.width = 200.;
    n.height = 200.;
    n.transform = Transform([1., 0., 0., 1., x, y]);
    n.children = children.iter().map(|c| (*c).into()).collect();
    n
}

/// A valid prototype document: two frames whose logically shared layer keeps
/// the same (name, kind) across sides so the plan matches them (magic move),
/// plus one dissolve participant per side.
fn transition_document() -> Document {
    let nodes: BTreeMap<String, Node> = [
        frame("old", &["shared-old", "outgoing"], 0., 0.),
        frame("new", &["shared-new", "incoming"], 320., 200.),
        rect("shared-old", "shared", [1., 0., 0., 1., 10., 10.]),
        rect("shared-new", "shared", [2., 0., 0., 2., 140., 90.]),
        rect("outgoing", "outgoing", [1., 0., 0., 1., 10., 80.]),
        rect("incoming", "incoming", [1., 0., 0., 1., 140., 200.]),
    ]
    .into_iter()
    .map(|n| (n.id.clone(), n))
    .collect();
    Document {
        reviews: Vec::new(),
        design_system: None,
        prototype: None,
        fd_compatibility: None,
        schema_version: 1,
        color_management: None,
        raster_profile: None,
        id: "d".into(),
        name: "prototype".into(),
        pages: vec![Page {
            guides: vec![],
            id: "p".into(),
            name: "P".into(),
            children: vec!["old".into(), "new".into()],
            background: "#ffffff".into(),
        }],
        nodes: nodes.into(),
        fonts: BTreeMap::new(),
        animations: Vec::new(),
    }
}

// ---------------------------------------------------------------- registry

#[test]
fn spring_position_overshoots_without_invalidating_dissolve_opacity() {
    let doc = transition_document();
    let easing = futureox_design_kernel::animation::Easing::Spring { mass:1., stiffness:170., damping:18., velocity:0. };
    let p = easing.sample(0.35, 1000.);
    assert!(p > 1.);
    for p in [-0.15, p, 1.2] {
        let result = PlanTree::sample_document(&doc, "old", "new", p).unwrap();
        let x = result.nodes["shared-new"].transform.0[4];
        assert!((x - (10. + 130. * p)).abs() < 1e-9);
        assert!(result.nodes.values().all(|n| (0. ..=1.).contains(&n.opacity)));
        result.validate().unwrap();
    }
    assert!(PlanTree::sample_document(&doc,"old","new",f64::NAN).is_err());
    assert!(PlanTree::sample_document(&doc,"old","new",11.).is_err());
}

#[test]
fn matched_layer_opacity_and_translation_meet_halfway() {
    let mut doc = transition_document();
    doc.nodes.get_mut("shared-old").unwrap().opacity = 1.;
    doc.nodes.get_mut("shared-new").unwrap().opacity = 0.2;
    let mid = PlanTree::sample_document(&doc, "old", "new", 0.5).unwrap();
    let shared = &mid.nodes["shared-new"];
    assert!((shared.opacity - 0.6).abs() < 1e-9);
    assert!((shared.transform.0[4] - 75.).abs() < 1e-6);
    assert!((shared.transform.0[5] - 50.).abs() < 1e-6);
    let end = PlanTree::sample_document(&doc, "old", "new", 1.).unwrap();
    assert!((end.nodes["shared-new"].opacity - 0.2).abs() < 1e-9);
}

#[test]
fn in_flight_bake_conflicts_on_any_shared_endpoint() {
    let registry = SaBakeRegistry::new();
    let _guard = registry.begin_bake("frame-a", 7, "frame-b", 7).unwrap();
    assert_eq!(registry.in_flight_len(), 1);
    // The 4-way endpoint comparison: every combination sharing one endpoint
    // with the in-flight pair (a, b) conflicts.
    for (from, to) in [
        ("frame-a", "frame-b"), // identical pair (start+dest)
        ("frame-a", "frame-c"), // start == in-flight start
        ("frame-c", "frame-a"), // dest == in-flight start
        ("frame-b", "frame-c"), // start == in-flight dest
        ("frame-c", "frame-b"), // dest == in-flight dest
        ("frame-b", "frame-a"), // reversed pair shares both endpoints
    ] {
        let conflict: BakeConflict = registry.begin_bake(from, 7, to, 7).unwrap_err();
        assert_eq!(conflict.kind, 2, "pair {from} -> {to}");
        assert_eq!(conflict.tag, "bake");
        assert_eq!(
            conflict.message,
            "A bake in flight already uses the start or destination frame"
        );
        assert!(conflict.source_file.ends_with("animation_bake.rs"));
        assert!(conflict.line > 0);
        assert_eq!(conflict.requested.0.frame_id, from);
        assert_eq!(conflict.requested.1.frame_id, to);
        assert_eq!(conflict.requested.0.generation, 7);
        assert_eq!(conflict.in_flight.0.frame_id, "frame-a");
        assert_eq!(conflict.in_flight.1.frame_id, "frame-b");
    }
    // A fully disjoint pair is free to bake concurrently (keep its guard
    // alive so the registry count proves both pairs are registered).
    let disjoint = registry.begin_bake("frame-c", 7, "frame-d", 7).unwrap();
    assert_eq!(registry.in_flight_len(), 2);
    drop(disjoint);
}

#[test]
fn guard_release_reopens_the_frame_pair() {
    let registry = SaBakeRegistry::new();
    {
        let guard = registry.begin_bake("a", 1, "b", 1).unwrap();
        let (start, dest) = guard.frame_pair();
        assert_eq!(start.frame_id, "a");
        assert_eq!(dest.frame_id, "b");
        assert!(
            registry.begin_bake("a", 1, "b", 1).is_err(),
            "the pair is in flight while the guard lives"
        );
    } // Drop = the cleanupBaked counterpart: the pair is released.
    assert_eq!(registry.in_flight_len(), 0);
    let _again = registry.begin_bake("a", 1, "b", 1).unwrap();
    assert_eq!(registry.in_flight_len(), 1);
}

#[test]
fn generation_mismatch_is_not_a_conflict() {
    // The engine compares (frameId, generation) on both halves: a newer
    // generation of the same frame id is a different reference, so an edit
    // that bumped the revision naturally invalidates old references.
    let registry = SaBakeRegistry::new();
    let _guard = registry.begin_bake("a", 1, "b", 1).unwrap();
    let regen = registry.begin_bake("a", 2, "b", 2).unwrap();
    let disjoint = registry.begin_bake("c", 2, "d", 2).unwrap();
    // Matching generation on one endpoint still conflicts.
    assert!(registry.begin_bake("a", 1, "c", 2).is_err());
    assert!(registry.begin_bake("c", 2, "b", 1).is_err());
    assert_eq!(registry.in_flight_len(), 3);
    drop(regen);
    drop(disjoint);
}

#[test]
fn concurrent_bakes_are_excluded_across_threads() {
    let registry = SaBakeRegistry::new();
    let (held, held_rx) = std::sync::mpsc::channel::<()>();
    let (release, release_rx) = std::sync::mpsc::channel::<()>();
    let worker = registry.clone();
    let handle = std::thread::spawn(move || {
        let _guard = worker.begin_bake("a", 3, "b", 3).unwrap();
        held.send(()).unwrap();
        release_rx.recv().unwrap(); // keep the bake in flight
    });
    held_rx.recv().unwrap();
    assert!(registry.begin_bake("a", 3, "c", 3).is_err());
    assert!(registry.begin_bake("c", 3, "b", 3).is_err());
    assert!(registry.begin_bake("c", 3, "d", 3).is_ok());
    release.send(()).unwrap();
    handle.join().unwrap();
    assert_eq!(registry.in_flight_len(), 0);
}

// ------------------------------------------------------------------- cache

#[test]
fn cache_miss_then_hit_tracks_three_axes() {
    let doc = transition_document();
    let cache = SaPlanCache::new(4);
    let key = SaPlanCacheKey::new("old", "new");
    let version = SaVersionTriple::from_revision(12);
    let tree = Arc::new(PlanTree::build(&doc, &doc, "old", "new"));
    // cold miss
    assert!(cache.lookup(&key, version).is_none());
    assert_eq!(
        cache.stats(),
        SaBakeCacheStats {
            hits: 0,
            lookups: 1,
            misses: 1
        }
    );
    cache.insert(key.clone(), version, Arc::clone(&tree));
    // warm hit returns the very same plan
    let hit = cache.lookup(&key, version).unwrap();
    assert!(Arc::ptr_eq(&hit, &tree));
    assert_eq!(
        cache.stats(),
        SaBakeCacheStats {
            hits: 1,
            lookups: 2,
            misses: 1
        }
    );
    // the telemetry invariant of the engine's three axes
    let stats = cache.stats();
    assert_eq!(stats.lookups, stats.hits + stats.misses);
    cache.clear();
    assert_eq!(cache.stats(), SaBakeCacheStats::default());
    assert!(cache.lookup(&key, version).is_none());
}

#[test]
fn version_triple_mismatch_invalidates_the_slot() {
    let doc = transition_document();
    let cache = SaPlanCache::new(4);
    let key = SaPlanCacheKey::new("old", "new");
    let tree = Arc::new(PlanTree::build(&doc, &doc, "old", "new"));
    cache.insert(key.clone(), SaVersionTriple::from_revision(1), tree);
    // unequal triple: the slot is invalidated, not served…
    assert!(
        cache
            .lookup(&key, SaVersionTriple::from_revision(2))
            .is_none()
    );
    assert_eq!(cache.len(), 0, "the stale slot was dropped");
    // …and the old version no longer hits afterwards either.
    assert!(
        cache
            .lookup(&key, SaVersionTriple::from_revision(1))
            .is_none()
    );
    assert_eq!(
        cache.stats(),
        SaBakeCacheStats {
            hits: 0,
            lookups: 2,
            misses: 2
        }
    );
}

#[test]
fn capacity_bound_evicts_oldest_insertion() {
    let doc = transition_document();
    let cache = SaPlanCache::new(2);
    for (from, to) in [("a", "b"), ("c", "d"), ("e", "f")] {
        let tree = Arc::new(PlanTree::build(&doc, &doc, "old", "new"));
        cache.insert(
            SaPlanCacheKey::new(from, to),
            SaVersionTriple::from_revision(1),
            tree,
        );
    }
    let oldest = SaPlanCacheKey::new("a", "b");
    assert!(
        cache.lookup(&oldest, SaVersionTriple::from_revision(1)).is_none(),
        "the oldest insertion was evicted past capacity"
    );
    for key in [SaPlanCacheKey::new("c", "d"), SaPlanCacheKey::new("e", "f")] {
        assert!(
            cache.lookup(&key, SaVersionTriple::from_revision(1)).is_some(),
            "newer insertions survive"
        );
    }
    assert_eq!(cache.len(), 2);
}

#[test]
fn reinsert_replaces_plan_and_version_in_place() {
    let doc = transition_document();
    let cache = SaPlanCache::new(4);
    let key = SaPlanCacheKey::new("old", "new");
    let first = Arc::new(PlanTree::build(&doc, &doc, "old", "new"));
    cache.insert(
        key.clone(),
        SaVersionTriple::from_revision(1),
        Arc::clone(&first),
    );
    let mut rebuilt = doc.clone();
    if let Some(n) = rebuilt.nodes.get_mut("shared-new") {
        n.transform = Transform([3., 0., 0., 3., 200., 120.]);
    }
    let second = Arc::new(PlanTree::build(&doc, &rebuilt, "old", "new"));
    cache.insert(
        key.clone(),
        SaVersionTriple::from_revision(2),
        Arc::clone(&second),
    );
    assert_eq!(cache.len(), 1, "same key replaces, it does not append");
    let hit = cache
        .lookup(&key, SaVersionTriple::from_revision(2))
        .unwrap();
    assert!(Arc::ptr_eq(&hit, &second));
    assert!(!Arc::ptr_eq(&hit, &first));
}

// ----------------------------------------------------------------- wiring

#[test]
fn bake_scans_the_registry_before_the_cache() {
    let (old_doc, new_doc) = (transition_document(), transition_document());
    let context = SaBakeContext::new();
    let first = PlanTree::bake(&old_doc, &new_doc, "old", "new", &context, 12).unwrap();
    assert_eq!(
        context.cache.stats(),
        SaBakeCacheStats {
            hits: 0,
            lookups: 1,
            misses: 1
        },
        "the first bake is a cold miss"
    );
    assert_eq!(first.guard.frame_pair().0.frame_id, "old");
    // The cache is warm, but the pair is still in flight: a second bake of
    // overlapping frames conflicts (the engine scans before constructing).
    let conflict = PlanTree::bake(&old_doc, &new_doc, "old", "new", &context, 12).unwrap_err();
    assert_eq!(conflict.in_flight.0.frame_id, "old");
    assert_eq!(conflict.requested.0.frame_id, "old");
    assert!(PlanTree::bake(&old_doc, &new_doc, "new", "other", &context, 12).is_err());
    // Disjoint frames bake fine even while (old -> new) is in flight.
    assert!(PlanTree::bake(&old_doc, &new_doc, "outgoing", "incoming", &context, 12).is_ok());
    let first_plan = Arc::clone(&first.plan);
    drop(first); // release the pair
    let second = PlanTree::bake(&old_doc, &new_doc, "old", "new", &context, 12).unwrap();
    assert!(
        Arc::ptr_eq(&second.plan, &first_plan),
        "after release the warm cache serves the identical plan"
    );
    assert_eq!(context.cache.stats().hits, 1);
}

#[test]
fn revision_bump_rebuilds_instead_of_serving_stale_geometry() {
    let old_doc = transition_document();
    let new_doc = transition_document();
    let context = SaBakeContext::new();
    let first = PlanTree::bake(&old_doc, &new_doc, "old", "new", &context, 7).unwrap();
    let first_plan = Arc::clone(&first.plan);
    drop(first);
    // Edit the new side, then bake again at the bumped revision.
    let mut edited = new_doc.clone();
    if let Some(n) = edited.nodes.get_mut("shared-new") {
        n.transform = Transform([3., 0., 0., 3., 200., 120.]);
    }
    let second = PlanTree::bake(&old_doc, &edited, "old", "new", &context, 8).unwrap();
    assert!(!Arc::ptr_eq(&second.plan, &first_plan));
    assert_eq!(
        context.cache.stats(),
        SaBakeCacheStats {
            hits: 0,
            lookups: 2,
            misses: 2
        },
        "the new version triple missed and the stale slot was replaced"
    );
    // The rebuilt plan actually carries the new geometry.
    let (_, _, b) = &second.plan.get_magic_move_plan()[0];
    assert_eq!(*b, [3., 0., 0., 3., 200., 120.]);
    let second_plan = Arc::clone(&second.plan);
    drop(second);
    // The pre-edit revision no longer hits: the slot was replaced.
    let third = PlanTree::bake(&old_doc, &new_doc, "old", "new", &context, 7).unwrap();
    assert!(!Arc::ptr_eq(&third.plan, &second_plan));
    assert_eq!(context.cache.stats().misses, 3);
}

#[test]
fn baked_plan_samples_identically_to_the_pure_path() {
    let doc = transition_document();
    doc.validate().unwrap();
    let context = SaBakeContext::new();
    let baked = PlanTree::bake(&doc, &doc, "old", "new", &context, 1).unwrap();
    // The fixture really exercises a magic move (matched (name, kind) pair).
    assert_eq!(baked.plan.get_magic_move_plan().len(), 1);
    for progress in [0., 0.25, 0.5, 0.75, 1.] {
        let pure = PlanTree::sample_document(&doc, "old", "new", progress).unwrap();
        let via_baked =
            PlanTree::sample_document_with_plan(&doc, "old", "new", progress, &baked.plan)
                .unwrap();
        assert_eq!(pure, via_baked, "progress {progress}");
    }
    // The shared plan is sampled repeatedly without ever rebuilding it.
    assert_eq!(context.cache.stats().lookups, 1);
}

#[test]
fn context_clones_share_registry_and_cache() {
    let (old_doc, new_doc) = (transition_document(), transition_document());
    let context = SaBakeContext::new();
    let other = context.clone();
    let baked = PlanTree::bake(&old_doc, &new_doc, "old", "new", &context, 5).unwrap();
    // Shared registry: the clone sees the pair in flight.
    assert!(PlanTree::bake(&old_doc, &new_doc, "old", "new", &other, 5).is_err());
    drop(baked);
    // Shared cache: the clone serves the warm plan.
    let hit = PlanTree::bake(&old_doc, &new_doc, "old", "new", &other, 5).unwrap();
    assert_eq!(other.cache.stats().hits, 1);
    drop(hit);
    assert_eq!(context.registry.in_flight_len(), 0);
}

// ----------------------------------------------------------------- session

#[test]
fn session_rebake_of_same_pair_hits_the_cache_and_samples_match_the_pure_path() {
    let doc = transition_document();
    let mut session = SaBakeSession::new();
    // Sampling before any bake is an error, not an empty document.
    assert!(session.sample(0.5).is_err());
    session.bake(&doc, &doc, "old", "new", 3).unwrap();
    assert_eq!(
        session.stats(),
        SaBakeCacheStats {
            hits: 0,
            lookups: 1,
            misses: 1
        },
        "the first bake is a cold miss"
    );
    // The playback loop: many samples, no rebuild (still a single lookup).
    for progress in [0., 0.25, 0.5, 0.75, 1.] {
        let pure = PlanTree::sample_document(&doc, "old", "new", progress).unwrap();
        assert_eq!(pure, session.sample(progress).unwrap(), "progress {progress}");
    }
    assert_eq!(session.stats().lookups, 1);
    // Re-baking the same pair at the same revision (the replay case) replaces
    // the guard without self-conflicting and is served by the warm cache.
    session.bake(&doc, &doc, "old", "new", 3).unwrap();
    assert_eq!(
        session.stats(),
        SaBakeCacheStats {
            hits: 1,
            lookups: 2,
            misses: 1
        },
        "the second identical bake is a cache hit"
    );
    assert!(session.sample(0.5).is_ok());
}

#[test]
fn session_revision_bump_rebuilds_and_shared_context_surfaces_conflicts() {
    let doc = transition_document();
    let context = SaBakeContext::new();
    let mut first = SaBakeSession::with_context(context.clone());
    first.bake(&doc, &doc, "old", "new", 3).unwrap();
    // A second session over the same context collides with the in-flight pair.
    let mut second = SaBakeSession::with_context(context.clone());
    let conflict: BakeConflict = second.bake(&doc, &doc, "old", "new", 3).unwrap_err();
    assert_eq!(conflict.kind, 2);
    assert_eq!(conflict.tag, "bake");
    assert_eq!(
        conflict.message,
        "A bake in flight already uses the start or destination frame"
    );
    assert!(second.sample(0.5).is_err(), "a failed bake leaves no plan");
    // The conflicting bake consumed no cache lookup: the registry scan runs
    // before the cache, like the engine.
    assert_eq!(context.cache.stats().lookups, 1);
    // A bumped revision rebuilds instead of serving the stale slot.
    first.bake(&doc, &doc, "old", "new", 4).unwrap();
    assert_eq!(first.stats().misses, 2);
    // Dropping the session releases the pair for the other session.
    drop(first);
    assert_eq!(context.registry.in_flight_len(), 0);
    second.bake(&doc, &doc, "old", "new", 4).unwrap();
    assert_eq!(
        second.stats().hits,
        1,
        "after release the warm cache serves the freed pair"
    );
}
