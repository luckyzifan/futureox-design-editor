//! Translation of an already materialized nested component instance.
//!
//! A drag writes one transform override and the same transform on that
//! generated instance. Re-expanding the owner rebuilds every nested instance
//! and variant binding even though the variant did not change. When the
//! materialized tree already matches that override, callers keep it.
use crate::{
    editing::DocumentPatch,
    layout::{self, Flow, SizeMode},
    scene::{Document, Node},
};
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
std::thread_local! {
    pub(crate) static FAST_DERIVATION: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    pub(crate) static FAST_REDRAW: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

fn paints_image(node: &Node) -> bool {
    node.fills.iter().any(|paint| paint.image.is_some())
        || node
            .strokes
            .iter()
            .any(|stroke| stroke.paint.image.is_some())
}

fn transform_only(old: &Node, next: &Node) -> bool {
    if old.transform.0[..4]
        .iter()
        .zip(next.transform.0)
        .any(|(a, b)| a.to_bits() != b.to_bits())
    {
        return false;
    }
    let mut candidate = old.clone();
    candidate.transform = next.transform;
    candidate == *next
}

fn override_translations(
    old: &Node,
    next: &Node,
) -> Option<BTreeMap<String, crate::math::Transform>> {
    if old.instance_origin.is_some()
        || next.instance_origin.is_some()
        || !transform_only_instance(old, next)
    {
        return None;
    }
    let (old_instance, next_instance) = (old.instance.as_ref()?, next.instance.as_ref()?);
    if old_instance.component_id != next_instance.component_id
        || old_instance.property_values != next_instance.property_values
        || old_instance.slot_contents != next_instance.slot_contents
    {
        return None;
    }
    let mut moves = BTreeMap::new();
    let keys: BTreeSet<_> = old_instance
        .overrides
        .keys()
        .chain(next_instance.overrides.keys())
        .collect();
    for key in keys {
        let mut before = old_instance.overrides.get(key).cloned().unwrap_or_default();
        let mut after = next_instance
            .overrides
            .get(key)
            .cloned()
            .unwrap_or_default();
        let before_transform = before.remove("transform");
        let after_transform = after.remove("transform");
        if before == after && before_transform == after_transform {
            continue;
        }
        if before != after {
            return None;
        }
        let transform = serde_json::from_value(after_transform?).ok()?;
        moves.insert((*key).clone(), transform);
    }
    (!moves.is_empty()).then_some(moves)
}

fn transform_only_instance(old: &Node, next: &Node) -> bool {
    let mut candidate = old.clone();
    candidate.instance = next.instance.clone();
    candidate == *next
}

fn subtree_blocks(doc: &Document, root: &str) -> bool {
    let mut stack = vec![root.to_owned()];
    let mut seen = BTreeSet::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            return true;
        }
        let Some(node) = doc.nodes.get(&id) else {
            return true;
        };
        if node.mask
            || node.boolean_operation.is_some()
            || node.repeat.is_some()
            || node.connector.is_some()
            || node.text_path.is_some()
            || node.component.is_some()
            || node.component_set
            || paints_image(node)
            || node.effects.iter().any(|effect| effect.visible)
            || !node.bindings.is_empty()
            || !node.variable_modes.is_empty()
            || !node.style_refs.is_empty()
        {
            return true;
        }
        stack.extend(node.children.iter().cloned());
    }
    false
}

fn ancestor_blocks(doc: &Document, id: &str, parents: &BTreeMap<String, String>) -> bool {
    for (index, id) in super::ancestors(id, parents).into_iter().enumerate() {
        let Some(node) = doc.nodes.get(&id) else {
            return true;
        };
        if index > 0
            && (node
                .layout
                .as_ref()
                .is_some_and(|layout| layout.mode != Flow::None)
                || node.sizing.as_ref().is_some_and(|sizing| {
                    sizing.width != SizeMode::Fixed || sizing.height != SizeMode::Fixed
                }))
        {
            return true;
        }
        if node.mask
            || node.boolean_operation.is_some()
            || node.repeat.is_some()
            || node.connector.is_some()
            || node.component.is_some()
            || node.component_set
            || !node.bindings.is_empty()
            || !node.variable_modes.is_empty()
            || !node.style_refs.is_empty()
        {
            return true;
        }
        let parent = parents.get(&id).and_then(|parent| doc.nodes.get(parent));
        if !layout::pose_constraint_fixed(node, parent, parent.is_none()) {
            return true;
        }
    }
    false
}

fn connector_follows(
    doc: &Document,
    moved: &BTreeSet<&str>,
    parents: &BTreeMap<String, String>,
) -> bool {
    doc.nodes.values().any(|node| {
        node.connector.as_ref().is_some_and(|connector| {
            [
                connector.from.node_id.as_deref(),
                connector.to.node_id.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|target| {
                let mut id = target.to_owned();
                let mut seen = BTreeSet::new();
                loop {
                    if moved.contains(id.as_str()) {
                        return true;
                    }
                    if !seen.insert(id.clone()) {
                        return true;
                    }
                    match parents.get(&id) {
                        Some(parent) => id.clone_from(parent),
                        None => return false,
                    }
                }
            })
        })
    })
}

/// Moved nested-instance ids, when the patch is only their translation overrides.
pub(crate) fn translation(
    doc: &Document,
    patch: &DocumentPatch,
) -> Option<BTreeMap<String, crate::math::Transform>> {
    if !patch.fields.is_empty()
        || patch.nodes.is_empty()
        || patch.nodes.len() > 16
        || !doc.animations.is_empty()
        || doc.prototype.is_some()
        || crate::repeat::has_repeats(doc)
        || crate::spatial::has_spatial(doc)
    {
        return None;
    }
    let parents = super::parents(doc);
    let mut moves = BTreeMap::new();
    let mut owners: BTreeMap<String, BTreeMap<String, crate::math::Transform>> = BTreeMap::new();
    for (id, next) in &patch.nodes {
        let (Some(old), Some(next)) = (doc.nodes.get(id), next.as_ref()) else {
            return None;
        };
        if old.instance_origin.is_some() && old.instance.is_some() && next.instance.is_some() {
            // Top-level instances have no origin. Plain generated layers have
            // no instance of their own. Both stay on the full resolver.
            if !transform_only(old, next) || old.transform == next.transform {
                return None;
            }
            moves.insert(id.clone(), next.transform);
        } else if old.instance.is_some() && old.instance_origin.is_none() {
            owners.insert(id.clone(), override_translations(old, next)?);
        } else {
            return None;
        }
    }
    if moves.is_empty() || owners.is_empty() {
        return None;
    }
    let mut moved_ids: BTreeSet<&str> = moves.keys().map(String::as_str).collect();
    let mut stack: Vec<&str> = moved_ids.iter().copied().collect();
    while let Some(id) = stack.pop() {
        if let Some(node) = doc.nodes.get(id) {
            for child in &node.children {
                if moved_ids.insert(child.as_str()) {
                    stack.push(child.as_str());
                }
            }
        }
    }
    if connector_follows(doc, &moved_ids, &parents) {
        return None;
    }
    for (id, transform) in &moves {
        let origin = doc.nodes[id].instance_origin.as_ref()?;
        let expected = owners.get(&origin.owner)?.get(&origin.key)?;
        if expected != transform || subtree_blocks(doc, id) || ancestor_blocks(doc, id, &parents) {
            return None;
        }
    }
    for (owner, overrides) in &owners {
        for key in overrides.keys() {
            let matched = moves.keys().any(|id| {
                doc.nodes[id]
                    .instance_origin
                    .as_ref()
                    .is_some_and(|origin| &origin.owner == owner && &origin.key == key)
            });
            if !matched {
                return None;
            }
        }
    }
    Some(moves)
}

#[cfg(test)]
pub(crate) fn fast_derivation_count() -> u32 {
    FAST_DERIVATION.with(std::cell::Cell::get)
}
#[cfg(test)]
pub(crate) fn fast_redraw_count() -> u32 {
    FAST_REDRAW.with(std::cell::Cell::get)
}
