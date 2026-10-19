//! Animation plan tree: the transition planning layer decoded from the
//! engine's exported surface (`_AnimationPlanTreeBindings` ×34,
//! `_AnimationPlanTreeNode_Internal` ×24).
//!
//! Semantics recovered from the API contract:
//! - a plan pairs an OLD scene tree with a NEW scene tree around a
//!   prototype transition;
//! - `getNodeMatches` aligns nodes across the pair - matched nodes tween
//!   (magic move), unmatched leaves dissolve (fade) on their own side
//!   (`forDissolveStart` / `forDissolveEnd`);
//! - matched nodes carry `oldCanvasTransform`/`newCanvasTransform` and are
//!   classified (`rotatesOrScales`, `scalesIndependentlyOfParent`);
//! - `subtreeWillChange` propagates change hints up the tree;
//! - `getFramePairDragTranslationDelta` reports the drag translation that
//!   connects the two frames of the pair.
use crate::scene::{Document, Node};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanNode {
    pub scene_node_id: Option<String>,
    pub old_scene_node_id: Option<String>,
    /// Scene-graph transform on the old / new side; `None` on the side
    /// where the node does not participate.
    pub old_canvas_transform: Option<[f64; 6]>,
    pub new_canvas_transform: Option<[f64; 6]>,
    /// Dissolve participants fade instead of tweening.
    pub is_dissolve: bool,
    /// Matched nodes tween between their two transforms (magic move).
    pub is_matched: bool,
    pub subtree_will_change: bool,
    pub children: Vec<PlanNode>,
}

impl PlanNode {
    fn from_scene(node: &Node, doc: &Document, new_side: bool) -> PlanNode {
        let mut plan = PlanNode {
            scene_node_id: Some(node.id.clone()),
            old_scene_node_id: if new_side {
                None
            } else {
                Some(node.id.clone())
            },
            old_canvas_transform: None,
            new_canvas_transform: None,
            is_dissolve: false,
            is_matched: false,
            subtree_will_change: false,
            children: node
                .children
                .iter()
                .filter_map(|id| doc.nodes.get(id))
                .map(|c| PlanNode::from_scene(c, doc, new_side))
                .collect(),
        };
        let m = node.transform.0;
        if new_side {
            plan.new_canvas_transform = Some(m);
        } else {
            plan.old_canvas_transform = Some(m);
        }
        plan
    }

    /// True when the node rotates or scales between its two transforms
    /// (linear components differ) - the engine's `rotatesOrScales`.
    pub fn rotates_or_scales(&self) -> bool {
        match (self.old_canvas_transform, self.new_canvas_transform) {
            (Some(a), Some(b)) => {
                (a[0] - b[0]).abs() > 1e-9
                    || (a[1] - b[1]).abs() > 1e-9
                    || (a[2] - b[2]).abs() > 1e-9
                    || (a[3] - b[3]).abs() > 1e-9
            }
            _ => false,
        }
    }

    /// True when the node moves at all between its two transforms -
    /// translation or linear change. Magic-move lists every moving match,
    /// not just the rotating/scaling ones.
    pub fn moves(&self) -> bool {
        match (self.old_canvas_transform, self.new_canvas_transform) {
            (Some(a), Some(b)) => {
                self.rotates_or_scales() || (a[4] - b[4]).abs() > 1e-9 || (a[5] - b[5]).abs() > 1e-9
            }
            _ => false,
        }
    }

    /// True when this node scales while its matched parent does not - the
    /// engine's `scalesIndependentlyOfParent`.
    pub fn scales_independently_of_parent(&self, parent: Option<&PlanNode>) -> bool {
        let self_scales = self.rotates_or_scales();
        let parent_scales = parent.map(|p| p.rotates_or_scales()).unwrap_or(false);
        self_scales && !parent_scales
    }

    /// Propagate the will-change hint bottom-up (the engine's
    /// `setSubtreeWillChange` aggregation).
    pub fn refresh_subtree_will_change(&mut self) -> bool {
        let mut will = self.is_matched && self.moves();
        for child in &mut self.children {
            if child.refresh_subtree_will_change() {
                will = true;
            }
        }
        self.subtree_will_change = will;
        will
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanTree {
    pub root: PlanNode,
    /// Drag translation connecting the two frames of the pair
    /// (`getFramePairDragTranslationDelta`).
    pub frame_pair_drag_translation_delta: [f64; 2],
}

impl PlanTree {
    /// Build the plan for a transition between two scene SNAPSHOTS
    /// (`old_doc` -> `new_doc`) by aligning nodes on scene id
    /// (`getNodeMatches`): aligned ids tween, unmatched old leaves
    /// dissolve-out, unmatched new leaves dissolve-in.
    pub fn build(
        old_doc: &Document,
        new_doc: &Document,
        old_root: &str,
        new_root: &str,
    ) -> PlanTree {
        // Frame pairs always pair up (a prototype transition links two
        // distinct frames); matching happens at the children level, where
        // aligned ids tween and the rest dissolve on their own side.
        let mut root = match (old_doc.nodes.get(old_root), new_doc.nodes.get(new_root)) {
            (Some(old), Some(new)) => {
                let mut plan = PlanNode::from_scene(old, old_doc, false);
                Self::merge_new_side(&mut plan, new, old_doc, new_doc);
                plan
            }
            _ => PlanNode {
                scene_node_id: None,
                old_scene_node_id: None,
                old_canvas_transform: old_doc.nodes.get(old_root).map(|n| n.transform.0),
                new_canvas_transform: new_doc.nodes.get(new_root).map(|n| n.transform.0),
                is_dissolve: true,
                is_matched: false,
                subtree_will_change: false,
                children: Vec::new(),
            },
        };
        root.refresh_subtree_will_change();
        let delta = Self::frame_delta(old_doc, new_doc, old_root, new_root);
        PlanTree {
            root,
            frame_pair_drag_translation_delta: delta,
        }
    }

    /// The bake-track entry point (the engine's `bakeSmartAnimateTransition`
    /// minimal loop): register the frame pair in the in-flight registry,
    /// then serve the plan from the result cache, building and caching it on
    /// a miss. The returned guard keeps the pair in flight until dropped —
    /// the `cleanupBakedSmartAnimateTransition` counterpart.
    ///
    /// Ordering follows the engine (`#25970` scans the in-flight set before
    /// any construction): a warm cache never bypasses mutual exclusion, so a
    /// second bake of overlapping frames fails with a structured
    /// [`BakeConflict`](crate::animation_bake::BakeConflict) even when the
    /// plan is already cached.
    ///
    /// `revision` is the document revision of the snapshots (the editing
    /// layer's monotonic counter); it stands in for the engine's per-frame
    /// generation counter, both as the in-flight reference generation and as
    /// the cache's version triple.
    pub fn bake(
        old_doc: &Document,
        new_doc: &Document,
        old_root: &str,
        new_root: &str,
        context: &crate::animation_bake::SaBakeContext,
        revision: u64,
    ) -> Result<crate::animation_bake::SaBakedPlan, crate::animation_bake::BakeConflict> {
        let guard = context
            .registry
            .begin_bake(old_root, revision, new_root, revision)?;
        let key = crate::animation_bake::SaPlanCacheKey::new(old_root, new_root);
        let version = crate::animation_bake::SaVersionTriple::from_revision(revision);
        let plan = match context.cache.lookup(&key, version) {
            Some(plan) => plan,
            None => {
                let plan = std::sync::Arc::new(Self::build(old_doc, new_doc, old_root, new_root));
                context
                    .cache
                    .insert(key, version, std::sync::Arc::clone(&plan));
                plan
            }
        };
        Ok(crate::animation_bake::SaBakedPlan { plan, guard })
    }

    /// Transient prototype document. Rendering remains in the same exact
    /// kernel; transforms use the existing decomposed animation interpolator.
    ///
    /// Pure path (unchanged behavior): builds the plan for the pair, then
    /// samples it. Callers driving many progress ticks re-use one baked plan
    /// via [`PlanTree::sample_document_with_plan`] instead.
    pub fn sample_document(
        doc: &Document,
        from: &str,
        to: &str,
        progress: f64,
    ) -> Result<Document, String> {
        let plan = Self::build(doc, doc, from, to);
        Self::sample_document_with_plan(doc, from, to, progress, &plan)
    }

    /// Sample a prototype transition through an already-built plan (one bake
    /// per transition, many samples — the point of the bake-result cache).
    /// The plan is trusted to describe this exact document pair; the cache's
    /// version triple validated at bake time is that contract.
    pub fn sample_document_with_plan(
        doc: &Document,
        from: &str,
        to: &str,
        progress: f64,
        plan: &PlanTree,
    ) -> Result<Document, String> {
        doc.validate()?;
        // This is eased position, not clock time. Underdamped springs and
        // cubic curves can overshoot; only bounded paint properties clamp.
        if !progress.is_finite() || !(-10. ..=10.).contains(&progress) {
            return Err("Invalid prototype progress".into());
        }
        let old_root = doc.nodes.get(from).ok_or("Prototype source missing")?;
        let new_root = doc.nodes.get(to).ok_or("Prototype target missing")?;
        let mut output = doc.clone();
        if progress == 1. {
            return Ok(output);
        }
        output.animations.clear();
        fn retire_to_target(output: &mut Document, id: &str, parent: &str, t: f64) {
            for n in output.nodes.values_mut() {
                n.children.retain(|child| child != id);
            }
            for page in &mut output.pages {
                page.children.retain(|child| child != id);
            }
            output
                .nodes
                .get_mut(parent)
                .unwrap()
                .children
                .push(id.into());
            output.nodes.get_mut(id).unwrap().opacity *= (1. - t).clamp(0., 1.);
        }
        fn sample(plan: &PlanNode, doc: &Document, output: &mut Document, t: f64, parent: &str) {
            let Some(id) = &plan.scene_node_id else {
                return;
            };
            if plan.is_matched {
                let Some(old) = plan
                    .old_scene_node_id
                    .as_ref()
                    .and_then(|id| doc.nodes.get(id))
                else {
                    return;
                };
                let Some(new) = doc.nodes.get(id) else { return };
                let a = crate::animation::Pose::from(old);
                let b = crate::animation::Pose::from(new);
                let compatible = crate::animation::compatible(&a, &b)
                    && (old.kind != "text"
                        || (old.text == new.text
                            && old.font_size == new.font_size
                            && old.text_style == new.text_style
                            && old.text_runs == new.text_runs));
                if compatible {
                    crate::animation::interpolate(&a, &b, t, 0, doc.color_management)
                        .apply(output.nodes.get_mut(id).unwrap());
                    for child in &plan.children {
                        sample(child, doc, output, t, id);
                    }
                } else {
                    output.nodes.get_mut(id).unwrap().opacity = new.opacity * t.clamp(0., 1.);
                    if old.id != new.id {
                        retire_to_target(output, &old.id, parent, t);
                    }
                }
            } else if plan.old_canvas_transform.is_some() {
                // Reparent the old unmatched subtree into the transient target;
                // the source frame is hidden by the preview isolation layer.
                retire_to_target(output, id, parent, t);
            } else if let Some(n) = output.nodes.get_mut(id) {
                n.opacity *= t.clamp(0., 1.);
            }
        }
        for child in &plan.root.children {
            sample(child, doc, &mut output, progress, to);
        }
        // Frame placement in the editor is not an animation travel distance.
        let root = output.nodes.get_mut(to).unwrap();
        root.width = (old_root.width + (new_root.width - old_root.width) * progress).clamp(0.01, 1e7);
        root.height = (old_root.height + (new_root.height - old_root.height) * progress).clamp(0.01, 1e7);
        // Solved child transforms are authoritative during the transition.
        for n in output.nodes.values_mut() {
            n.layout = None;
        }
        output.validate()?;
        Ok(output)
    }

    fn merge_new_side(plan: &mut PlanNode, new: &Node, old_doc: &Document, new_doc: &Document) {
        plan.new_canvas_transform = Some(new.transform.0);
        plan.scene_node_id = Some(new.id.clone());
        plan.is_matched = true;
        // Match children by id; unmatched new children dissolve in.
        let mut remaining: BTreeMap<&String, &Node> = new
            .children
            .iter()
            .filter_map(|id| new_doc.nodes.get(id).map(|n| (&n.id, n)))
            .collect();
        let old_counts = plan
            .children
            .iter()
            .filter_map(|c| old_doc.nodes.get(c.scene_node_id.as_deref()?))
            .fold(BTreeMap::new(), |mut counts, n| {
                *counts
                    .entry((n.name.clone(), n.kind.clone()))
                    .or_insert(0usize) += 1;
                counts
            });
        for child in &mut plan.children {
            let old = child
                .scene_node_id
                .as_ref()
                .and_then(|id| old_doc.nodes.get(id));
            let exact = remaining
                .get(&child.scene_node_id.clone().unwrap_or_default())
                .copied();
            let candidates: Vec<_> = remaining
                .values()
                .filter(|n| {
                    old.is_some_and(|o| {
                        !o.name.is_empty()
                            && n.name == o.name
                            && n.kind == o.kind
                            && old_counts.get(&(o.name.clone(), o.kind.clone())) == Some(&1)
                    })
                })
                .copied()
                .collect();
            let matched = exact.or_else(|| (candidates.len() == 1).then(|| candidates[0]));
            if let Some(matched) = matched {
                remaining.remove(&matched.id);
                Self::merge_new_side(child, matched, old_doc, new_doc);
            } else {
                child.is_dissolve = true;
            }
        }
        for (_, unmatched) in remaining {
            let mut fresh = PlanNode::from_scene(unmatched, new_doc, true);
            fresh.is_dissolve = true;
            plan.children.push(fresh);
        }
    }

    fn frame_delta(
        old_doc: &Document,
        new_doc: &Document,
        old_root: &str,
        new_root: &str,
    ) -> [f64; 2] {
        let t = |doc: &Document, id: &str| {
            doc.nodes
                .get(id)
                .map(|n| (n.transform.0[4], n.transform.0[5]))
        };
        match (t(old_doc, old_root), t(new_doc, new_root)) {
            (Some((ox, oy)), Some((nx, ny))) => [nx - ox, ny - oy],
            _ => [0., 0.],
        }
    }

    /// The dissolve-start projection: only nodes dissolving out of the old
    /// scene (`forDissolveStart`).
    pub fn for_dissolve_start(&self) -> Vec<&PlanNode> {
        let mut out = Vec::new();
        fn walk<'a>(n: &'a PlanNode, out: &mut Vec<&'a PlanNode>) {
            if n.is_dissolve && n.old_canvas_transform.is_some() {
                out.push(n);
            }
            for c in &n.children {
                walk(c, out);
            }
        }
        walk(&self.root, &mut out);
        out
    }

    /// The dissolve-end projection: nodes dissolving into the new scene
    /// (`forDissolveEnd`).
    pub fn for_dissolve_end(&self) -> Vec<&PlanNode> {
        let mut out = Vec::new();
        fn walk<'a>(n: &'a PlanNode, out: &mut Vec<&'a PlanNode>) {
            if n.is_dissolve && n.new_canvas_transform.is_some() {
                out.push(n);
            }
            for c in &n.children {
                walk(c, out);
            }
        }
        walk(&self.root, &mut out);
        out
    }

    /// Magic-move plan (`getMagicMovePlan`): the matched CHILDREN that
    /// actually move (translation or linear change), each with its from/to
    /// canvas transforms. The frame pair itself is excluded - its motion is
    /// reported as `frame_pair_drag_translation_delta` instead.
    pub fn get_magic_move_plan(&self) -> Vec<(&PlanNode, [f64; 6], [f64; 6])> {
        let mut out = Vec::new();
        fn walk<'a>(n: &'a PlanNode, out: &mut Vec<(&'a PlanNode, [f64; 6], [f64; 6])>) {
            for c in &n.children {
                if c.is_matched
                    && c.moves()
                    && let (Some(a), Some(b)) = (c.old_canvas_transform, c.new_canvas_transform)
                {
                    out.push((c, a, b));
                }
                walk(c, out);
            }
        }
        walk(&self.root, &mut out);
        out
    }

    /// Interpolate a matched node's canvas transform at progress `t`
    /// (0 = old, 1 = new): linear components lerp, translation lerps.
    pub fn tween(a: [f64; 6], b: [f64; 6], t: f64) -> [f64; 6] {
        let lerp = |x: f64, y: f64| x + (y - x) * t;
        [
            lerp(a[0], b[0]),
            lerp(a[1], b[1]),
            lerp(a[2], b[2]),
            lerp(a[3], b[3]),
            lerp(a[4], b[4]),
            lerp(a[5], b[5]),
        ]
    }

    pub fn lookup(&self, id: &str) -> Option<&PlanNode> {
        fn walk<'a>(n: &'a PlanNode, id: &str) -> Option<&'a PlanNode> {
            if n.scene_node_id.as_deref() == Some(id) {
                return Some(n);
            }
            n.children.iter().find_map(|c| walk(c, id))
        }
        walk(&self.root, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facet::sample_node;
    use crate::math::Transform;

    fn node_at(id: &str, x: f64, y: f64) -> Node {
        let mut n = sample_node(id, "rectangle");
        n.width = 100.;
        n.height = 50.;
        n.transform = Transform([1., 0., 0., 1., x, y]);
        n
    }

    fn doc_pair() -> (Document, Document, String, String) {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d".into(),
            name: "d".into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            fonts: BTreeMap::new(),
            animations: Vec::new(),
        };
        let mut old = sample_node("old", "frame");
        old.transform = Transform([1., 0., 0., 1., 0., 0.]);
        old.children = vec!["shared".into(), "outgoing".into()];
        let mut new = sample_node("new", "frame");
        new.transform = Transform([1., 0., 0., 1., 320., 200.]);
        new.children = vec!["shared".into(), "incoming".into()];
        doc.nodes.insert("old".into(), old);
        doc.nodes.insert("new".into(), new);
        doc.nodes
            .insert("shared".into(), node_at("shared", 10., 10.));
        doc.nodes
            .insert("outgoing".into(), node_at("outgoing", 10., 80.));
        doc.nodes
            .insert("incoming".into(), node_at("incoming", 140., 200.));
        doc.pages.push(crate::scene::Page {
            guides: vec![],
            id: "p".into(),
            name: "P".into(),
            children: vec!["old".into(), "new".into()],
            background: "#ffffff".into(),
        });
        // new snapshot: shared jumps+2x (magic move), incoming present
        let mut new_doc = doc.clone();
        if let Some(n) = new_doc.nodes.get_mut("shared") {
            n.transform = Transform([2., 0., 0., 2., 140., 90.]);
        }
        (doc, new_doc, "old".into(), "new".into())
    }

    #[test]
    fn matched_nodes_tween_and_dissolves_split_by_side() {
        let (old_doc, new_doc, old, new) = doc_pair();
        let tree = PlanTree::build(&old_doc, &new_doc, &old, &new);
        let shared = tree.lookup("shared").unwrap();
        assert!(shared.is_matched);
        assert!(shared.rotates_or_scales(), "2x scale counts as scaling");
        assert!(!shared.is_dissolve);
        let outgoing = tree.lookup("outgoing").unwrap();
        assert!(outgoing.is_dissolve);
        assert!(outgoing.old_canvas_transform.is_some());
        assert!(outgoing.new_canvas_transform.is_none());
        let incoming = tree.lookup("incoming").unwrap();
        assert!(incoming.is_dissolve);
        assert!(incoming.new_canvas_transform.is_some());
        assert!(incoming.old_canvas_transform.is_none());
        // dissolve projections pick exactly their side's participants
        let starts = tree.for_dissolve_start();
        let ends = tree.for_dissolve_end();
        assert_eq!(starts.len(), 1);
        assert_eq!(ends.len(), 1);
        assert_eq!(starts[0].scene_node_id.as_deref(), Some("outgoing"));
        assert_eq!(ends[0].scene_node_id.as_deref(), Some("incoming"));
    }

    #[test]
    fn magic_move_plan_lists_moving_matches_only() {
        let (old_doc, new_doc, old, new) = doc_pair();
        let tree = PlanTree::build(&old_doc, &new_doc, &old, &new);
        let plan = tree.get_magic_move_plan();
        assert_eq!(
            plan.len(),
            1,
            "frames + shared move; dissolve sides never do"
        );
        let (_, a, b) = &plan[0];
        assert_eq!(*a, [1., 0., 0., 1., 10., 10.]);
        assert_eq!(*b, [2., 0., 0., 2., 140., 90.]);
    }

    #[test]
    fn tween_is_endpoint_exact_and_midway_linear() {
        let a = [1., 0., 0., 1., 0., 0.];
        let b = [2., 0., 0., 2., 100., 40.];
        assert_eq!(PlanTree::tween(a, b, 0.), a);
        assert_eq!(PlanTree::tween(a, b, 1.), b);
        let mid = PlanTree::tween(a, b, 0.5);
        assert_eq!(mid, [1.5, 0., 0., 1.5, 50., 20.]);
    }

    #[test]
    fn frame_pair_drag_delta_connects_frames() {
        let (old_doc, new_doc, old, new) = doc_pair();
        let tree = PlanTree::build(&old_doc, &new_doc, &old, &new);
        assert_eq!(tree.frame_pair_drag_translation_delta, [320., 200.]);
    }

    #[test]
    fn subtree_will_change_propagates_upward() {
        let (old_doc, new_doc, old, new) = doc_pair();
        let mut tree = PlanTree::build(&old_doc, &new_doc, &old, &new);
        assert!(
            tree.root.subtree_will_change,
            "shared's motion marks the frame"
        );
        tree.root.refresh_subtree_will_change();
        assert!(tree.lookup("shared").unwrap().subtree_will_change);
        assert!(
            !tree.lookup("outgoing").unwrap().subtree_will_change,
            "dissolve sides do not count as change"
        );
    }

    #[test]
    fn scales_independently_of_parent_classifies() {
        let (old_doc, new_doc, old, new) = doc_pair();
        let tree = PlanTree::build(&old_doc, &new_doc, &old, &new);
        let shared = tree.lookup("shared").unwrap();
        assert!(shared.scales_independently_of_parent(Some(&tree.root)));
        assert!(!tree.root.scales_independently_of_parent(None));
    }
}

