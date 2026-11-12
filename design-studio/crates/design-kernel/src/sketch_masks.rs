//! Lower Sketch's ordered sibling masks on the private render document. The
//! authored node keeps its ID, material, placement and history in the editor.
use crate::scene::{Document, MaskChain, Node};
use std::collections::HashSet;

#[derive(serde::Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub(crate) enum DrawChange<'a> {
    Coverage {
        id: &'a str,
        source: &'a str,
        children: &'a [String],
        mask: bool,
        visible: bool,
    },
    Group {
        id: &'a str,
        children: &'a [String],
    },
    Paint {
        id: &'a str,
    },
    Alpha {
        id: &'a str,
    },
    Children {
        id: &'a str,
        children: &'a [String],
    },
    Page {
        index: usize,
        children: &'a [String],
    },
}

pub(crate) fn starts(n: &Node) -> bool {
    n.mask && (n.mask_type.as_deref() == Some("shape") || n.mask_chain.is_some())
}

/// A bitmap in this lowered two-sibling chain has one authoritative render
/// node. Updating its transform leaves the stationary mask and its private
/// silhouette intact. A higher mask would also have cloned this geometry.
pub(crate) fn stable_bitmap_pose(source: &Document, resolved: &Document, parents: &crate::render_index::Parents, id: &str) -> bool {
    let Some(image) = source.nodes.get(id) else { return false; };
    if image.mask || image.mask_chain == Some(MaskChain::Break) || !image.children.is_empty() ||
        !image.fills.iter().any(|paint| paint.visible && paint.kind == "image") {
        return false;
    }
    let mut ancestors = parents.ancestors(id);
    let Some(parent_id) = ancestors.next() else { return false; };
    let parent = &source.nodes[parent_id];
    if parent.kind != "group" || parent.mask || parent.children.len() != 2 || parent.children[1] != id ||
        ancestors.any(|id| source.nodes[id].mask) {
        return false;
    }
    let mask_id = &parent.children[0];
    let mask = &source.nodes[mask_id];
    if !mask.mask || mask.mask_type.as_deref() != Some("shape") ||
        mask.kind != "rectangle" || !mask.children.is_empty() {
        return false;
    }
    let group_id = crate::repeat::derived_id(&format!("sketch-mask-chain/{mask_id}"));
    let coverage_id = crate::repeat::derived_id(&format!("sketch-coverage/{}/{mask_id}{mask_id}", mask_id.len()));
    resolved.nodes.get(parent_id).is_some_and(|parent|
        matches!(parent.render_children(), [first, second] if first == mask_id && second == &group_id)) &&
        resolved.nodes.get(&group_id).is_some_and(|group|
            group.render_children().len() == 2 && group.render_children()[0] == coverage_id &&
            group.render_children()[1] == id) &&
        resolved.nodes.get(&coverage_id).is_some_and(|coverage| coverage.mask)
}

/// The authored parent index cannot invalidate a private clip group. Retain
/// local edits in unrelated branches; rebuild a chain when its inputs change.
pub(crate) fn owners(d: &Document, parents: &crate::render_index::Parents) -> HashSet<String> {
    let mut owners = HashSet::new();
    let mut page_masks = HashSet::new();
    for mask in d.nodes.values().filter(|n| starts(n)) {
        if let Some(parent) = parents.ancestors(&mask.id).next() {
            if d.nodes[parent].boolean_operation.is_none() {
                owners.insert(parent.to_owned());
            }
        } else {
            page_masks.insert(&mask.id);
        }
    }
    if !page_masks.is_empty() {
        for page in &d.pages {
            if page.children.iter().any(|id| page_masks.contains(id)) {
                owners.extend(page.children.iter().cloned());
            }
        }
    }
    owners
}

fn insert(d: &mut Document, node: Node, limit: usize) -> Result<String, String> {
    // Storage-mode source admission allows very large authored documents.
    // Private copies of nested silhouettes still need a finite working set.
    if d.nodes.len() >= limit {
        return Err("Sketch mask projection exceeds render node allowance".into());
    }
    crate::capacity::check_document_counts(d.nodes.len().saturating_add(1), d.pages.len())?;
    let id = node.id.clone();
    if d.nodes.contains_key(&id) {
        return Err("Sketch mask render identifier collision".into());
    }
    d.nodes.insert(id.clone(), node);
    Ok(id)
}

// The coverage is the path even for a fully transparent or hidden mask. For a
// group use its visible children's silhouettes. Resolved boolean operands have
// one path on their parent and must not be drawn a second time.
fn coverage(
    d: &mut Document,
    source: &str,
    mask: &str,
    root: bool,
    limit: usize,
    emit: &mut impl FnMut(DrawChange),
) -> Result<String, String> {
    let original = &d.nodes[source];
    let children = original.render_children().to_vec();
    let mut node = original.mask_geometry(true);
    node.id = crate::repeat::derived_id(&format!("sketch-coverage/{}/{mask}{source}", mask.len()));
    node.mask = root || original.mask;
    node.mask_type = None;
    node.mask_chain = None;
    node.visible |= root;
    node.children.clear();
    for child in children {
        node.children
            .push(coverage(d, &child, mask, false, limit, emit)?);
    }
    emit(DrawChange::Coverage {
        id: &node.id,
        source,
        children: &node.children,
        mask: node.mask,
        visible: node.visible,
    });
    insert(d, node, limit)
}

fn siblings(
    d: &mut Document,
    ids: &[String],
    limit: usize,
    emit: &mut impl FnMut(DrawChange),
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(ids.len());
    let mut at = 0;
    while at < ids.len() {
        let id = &ids[at];
        at += 1;
        if !starts(&d.nodes[id]) {
            out.push(id.clone());
            continue;
        }
        let begin = at;
        while at < ids.len() {
            let next = &d.nodes[&ids[at]];
            if next.mask || next.mask_chain == Some(MaskChain::Break) {
                break;
            }
            at += 1;
        }
        let shape = d.nodes[id].mask_type.as_deref() == Some("shape");
        if shape {
            // The visible paint sits below the clipped interval. Its own
            // opacity, blend, strokes and effects apply only to this draw.
            out.push(id.clone());
        }
        if !shape || at != begin {
            let group_id = crate::repeat::derived_id(&format!("sketch-mask-chain/{id}"));
            let mut group = crate::facet::sample_node(&group_id, "group");
            group.blend = "pass-through".into();
            group.children.push(if shape {
                coverage(d, id, id, true, limit, emit)?
            } else {
                id.clone()
            });
            group.children.extend_from_slice(&ids[begin..at]);
            emit(DrawChange::Group {
                id: &group_id,
                children: &group.children,
            });
            out.push(insert(d, group, limit)?);
        }
        let source = d.nodes.get_mut(id).unwrap();
        source.mask_chain = None;
        if shape {
            emit(DrawChange::Paint { id });
            source.mask = false;
            source.mask_type = None;
        } else {
            // Alpha masks have no visible underpaint. Sketch still samples
            // their material when their own appearance is hidden.
            emit(DrawChange::Alpha { id });
            source.visible = true;
        }
    }
    Ok(out)
}

pub(crate) fn resolve(d: &mut Document) -> Result<(), String> {
    resolve_with(d, &mut |_| {})
}

pub(crate) fn resolve_with(
    d: &mut Document,
    emit: &mut impl FnMut(DrawChange),
) -> Result<(), String> {
    // Post-order matters when the silhouette itself is a group with a mask.
    fn visit(
        d: &mut Document,
        ids: &[String],
        limit: usize,
        emit: &mut impl FnMut(DrawChange),
    ) -> Result<(), String> {
        for id in ids {
            let n = &d.nodes[id];
            if n.render_children().is_empty() {
                continue;
            }
            let children = n.children.clone();
            visit(d, &children, limit, emit)?;
            if children.iter().any(|id| starts(&d.nodes[id])) {
                let resolved = siblings(d, &children, limit, emit)?;
                emit(DrawChange::Children {
                    id,
                    children: &resolved,
                });
                d.nodes.get_mut(id).unwrap().children = resolved;
            }
        }
        Ok(())
    }
    let limit = d
        .nodes
        .len()
        .saturating_add((crate::capacity::memory_budget_bytes() / 4096) as usize);
    for i in 0..d.pages.len() {
        let roots = d.pages[i].children.clone();
        visit(d, &roots, limit, emit)?;
        if roots.iter().any(|id| starts(&d.nodes[id])) {
            d.pages[i].children = siblings(d, &roots, limit, emit)?;
            emit(DrawChange::Page {
                index: i,
                children: &d.pages[i].children,
            });
        }
    }
    Ok(())
}
