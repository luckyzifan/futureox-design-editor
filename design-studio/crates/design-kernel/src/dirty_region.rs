#![allow(clippy::cloned_ref_to_slice_refs)]
//! Dirty-region derivation over the op log.
//!
//! Editing currently re-renders the whole viewport per keystroke. This module
//! derives, from the ops applied between two document revisions, the
//! world-space bounds whose pixels can differ — then intersects that with the
//! tile grid used by the progressive canvas ([`crate::tile_stack`]) so callers
//! can repaint only the affected tiles.
//!
//! The contract is deliberately one-sided: over-reporting is allowed (extra
//! tiles are repainted needlessly), under-reporting is not (missing tiles show
//! stale pixels). Anything the derivation cannot bound — unknown op targets,
//! non-finite geometry, tile budgets exceeded — degrades to `full` instead of
//! guessing. All results are a pure function of the inputs; no clocks, no
//! iteration-order effects.
//!
//! Bounds are in *page/world space*: the same space [`crate::tile_stack::raster_addresses`]
//! expects, where `device = world * zoom + phase`.
use crate::font::Fonts;
use crate::math::Transform;
use crate::ops::Op;
use crate::scene::{Document, Node};
use crate::tile_stack::raster_addresses;
use std::collections::BTreeMap;

/// Tile addressing parameters; mirrors the arguments of
/// [`crate::tile_stack::raster_addresses`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileGrid {
    /// World-to-device scale. Must match the zoom used to render.
    pub zoom: f64,
    /// Device-space phase of the tile origin in `[0, 1)`.
    pub phase: [f64; 2],
    /// Upper bound on emitted tile addresses before degrading to full.
    pub limit: usize,
}

impl TileGrid {
    pub fn new(zoom: f64, phase: [f64; 2], limit: usize) -> Self {
        TileGrid { zoom, phase, limit }
    }
}

/// Result of a dirty-region derivation.
#[derive(Clone, Debug, PartialEq)]
pub struct DirtyRegion {
    /// `true` when the derivation cannot bound the change; the caller must
    /// re-render everything. Never a guess: it is set for unknown targets,
    /// non-finite geometry, or exceeded tile budgets.
    pub full: bool,
    /// Why `full` was chosen, for diagnostics and honest reporting.
    pub reason: Option<&'static str>,
    /// Union [x, y, width, height] in page units, before viewport clipping.
    /// `None` iff `full`.
    pub world_bounds: Option<[f64; 4]>,
    /// Bounded disjoint-or-overlapping paint rectangles; union above is compatibility metadata.
    pub world_rects: Vec<[f64; 4]>,
    /// Tile addresses covering `world_bounds ∩ viewport`, sorted and unique.
    /// Empty when nothing visible changed.
    pub tiles: Vec<[i32; 2]>,
}

#[derive(serde::Serialize)]
pub struct PatchDamage {
    /// Compiler policy/resources are unchanged; hosts may retain disjoint packets.
    #[serde(rename = "translationOnly", skip_serializing_if = "Option::is_none")]
    pub translation_only: Option<bool>,
    pub full: bool,
    /// Which conservative gate rejected the bounded proof; `Some` iff `full`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// World rectangle [x, y, width, height]. None with full=false means no paint change.
    pub bounds: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rects: Option<Vec<[f64; 4]>>,
}

/// Conservative production admission for skipping tile compilation. Complex
/// scenes retain their existing exact compilation-witness path. Logical boxes
/// are not a proof for text/path/connector/backdrop/layout dependencies.
/// Parent chain index for mask-chain checks: child id -> parent id.
fn parent_index(doc: &Document) -> BTreeMap<&str, &str> {
    parent_index_pages(doc, None)
}
fn parent_index_pages<'a>(doc: &'a Document, only: Option<&std::collections::BTreeSet<&'a str>>) -> BTreeMap<&'a str, &'a str> {
    let mut parents = BTreeMap::new();
    for page in &doc.pages {
        if only.is_some_and(|pages| !pages.contains(page.id.as_str())) { continue; }
        let mut stack: Vec<&String> = page.children.iter().collect();
        while let Some(id) = stack.pop() {
            if let Some(node) = doc.nodes.get(id) {
                note_indexed();
                for child in &node.children {
                    parents.insert(child.as_str(), id.as_str());
                }
                stack.extend(node.children.iter());
            }
        }
    }
    parents
}

struct DamageContext<'a> {
    document: &'a Document,
    pages: Option<std::collections::BTreeSet<&'a str>>,
    parents: BTreeMap<&'a str, &'a str>,
    with_pages: std::cell::OnceCell<BTreeMap<&'a str, &'a str>>,
}
impl<'a> DamageContext<'a> {
    fn new(document: &'a Document, pages: Option<&std::collections::BTreeSet<&'a str>>) -> Self {
        Self { document, pages: pages.cloned(), parents: parent_index_pages(document, pages),
            with_pages: std::cell::OnceCell::new() }
    }
    fn including_pages(&self) -> &BTreeMap<&'a str, &'a str> {
        self.with_pages.get_or_init(|| {
            // The optical map includes page roots. The mask-chain map does
            // not. Preserve the original traversal for ambiguous raw graphs.
            let selected = |page: &&crate::scene::Page| self.pages.as_ref().is_none_or(|ids| ids.contains(page.id.as_str()));
            if self.document.pages.iter().filter(selected).any(|page|
                self.document.nodes.contains_key(&page.id) || page.children.iter().any(|id| self.parents.contains_key(id.as_str()))) {
                return parent_map_pages(self.document, self.pages.as_ref());
            }
            #[cfg(test)]
            PARENT_MAP_CONSTRUCTIONS.with(|count| count.set(count.get() + 1));
            let mut parents = self.parents.clone();
            for page in self.document.pages.iter().filter(selected) {
                for id in &page.children { parents.insert(id.as_str(), page.id.as_str()); }
            }
            parents
        })
    }
}
/// Pages that own every edited id. None means an id is not under any page, so
/// the caller keeps the full index.
fn edited_pages<'a>(doc: &'a Document, ids: &[&str]) -> Option<std::collections::BTreeSet<&'a str>> {
    let mut pending: std::collections::BTreeSet<&str> = ids.iter().copied().filter(|id| doc.nodes.contains_key(*id)).collect();
    let mut pages = std::collections::BTreeSet::new();
    if pending.is_empty() { return Some(pages); }
    for page in &doc.pages {
        if pending.is_empty() { break; }
        let mut stack: Vec<&str> = page.children.iter().map(String::as_str).collect();
        let mut guard = 0usize;
        while let Some(id) = stack.pop() {
            guard += 1;
            if guard > doc.nodes.len() { return None; }
            if pending.remove(id) { pages.insert(page.id.as_str()); }
            if let Some(node) = doc.nodes.get(id) {
                stack.extend(node.children.iter().map(String::as_str));
            }
        }
    }
    pending.is_empty().then_some(pages)
}
fn foreign_connector_targets(doc: &Document, pages: &std::collections::BTreeSet<&str>, parents: &BTreeMap<&str, &str>, edited: &[&str]) -> bool {
    for page in &doc.pages {
        if pages.contains(page.id.as_str()) { continue; }
        let mut stack: Vec<&str> = page.children.iter().map(String::as_str).collect();
        while let Some(id) = stack.pop() {
            let Some(node) = doc.nodes.get(id) else { continue; };
            if let Some(connector) = &node.connector {
                for endpoint in [connector.from.node_id.as_deref(), connector.to.node_id.as_deref()].into_iter().flatten() {
                    if edited.iter().any(|id| inside_edited_subtree(parents, endpoint, id)) { return true; }
                }
            }
            stack.extend(node.children.iter().map(String::as_str));
        }
    }
    false
}
fn each_page_node<'a>(doc: &'a Document, pages: Option<&std::collections::BTreeSet<&str>>, mut visit: impl FnMut(&'a str, &'a Node) -> bool) -> bool {
    for page in &doc.pages {
        if pages.is_some_and(|set| !set.contains(page.id.as_str())) { continue; }
        let mut stack: Vec<&str> = page.children.iter().map(String::as_str).collect();
        let mut guard = 0usize;
        while let Some(id) = stack.pop() {
            guard += 1;
            if guard > doc.nodes.len() { return false; }
            let Some(node) = doc.nodes.get(id) else { continue; };
            if !visit(id, node) { return false; }
            stack.extend(node.children.iter().map(String::as_str));
        }
    }
    true
}
fn inside_edited_subtree(parents: &BTreeMap<&str, &str>, endpoint: &str, edited: &str) -> bool {
    let mut cursor = endpoint;
    loop {
        if cursor == edited { return true; }
        match parents.get(cursor) {
            Some(parent) => cursor = parent,
            None => return false,
        }
    }
}

pub fn patch_damage(
    before: &Document,
    after: &Document,
    patch: &crate::editing::DocumentPatch,
) -> PatchDamage {
    patch_damage_impl(before, after, patch, None, false)
}

/// Rendering supplies its actual default and embedded fonts. Logical text
/// boxes alone cannot certify damage: unwrapped glyphs can extend outside them.
pub(crate) fn patch_damage_with_fonts(
    before: &Document,
    after: &Document,
    patch: &crate::editing::DocumentPatch,
    fonts: &Fonts,
) -> PatchDamage {
    patch_damage_impl(before, after, patch, Some(fonts), false)
}

/// The Engine has proved that only material changes on an already resolved
/// scene. Geometry, layout, effect support and backdrop isolation are unchanged.
/// Use that resolved placement on both sides; authored child coordinates under
/// auto-layout are not a paint certificate. No extra document clone is needed.
pub(crate) fn resolved_material_damage(
    resolved: &Document,
    patch: &crate::editing::DocumentPatch,
    fonts: &Fonts,
) -> PatchDamage {
    patch_damage_impl(resolved, resolved, patch, Some(fonts), true)
}

/// A checked leaf-pose update preserves topology and resolved local geometry.
/// Borrow the existing parent index and evaluate only the old/new leaf paths.
/// Effects/masks on the affected path and any backdrop reading that isolation
/// keep the complete old damage derivation; no clip-box guess narrows support.
pub(crate) fn resolved_leaf_pose_damage(doc:&Document,parents:&crate::render_index::Parents,
    transforms:&BTreeMap<String,Transform>,fonts:&Fonts)->Option<PatchDamage>{
    if transforms.is_empty()||transforms.len()>16{return None}
    let contains=|ancestor:&str,child:&str|{
        if ancestor==child||parents.ancestors(child).any(|p|p==ancestor){return true}
        let root=parents.ancestors(child).last().unwrap_or(child);
        doc.pages.iter().any(|p|p.id==ancestor&&p.children.iter().any(|id|id==root))
    };
    for (id,node) in &doc.nodes{
        if node.effects.iter().any(|e|e.visible&&e.kind=="noise"){return None}
        if node.backdrop_effect().is_none(){continue}
        let mut root=id.as_str();let mut scope=None;
        for parent in parents.ancestors(id){
            if !doc.nodes.get(parent)?.passes_backdrop(){scope=Some(parent);break}
            root=parent;
        }
        let scope=scope.or_else(||doc.pages.iter().find(|p|p.children.iter().any(|id|id==root)).map(|p|p.id.as_str()))?;
        if transforms.keys().any(|edited|contains(scope,edited)||contains(edited,scope)){return None}
    }
    let mut union:Option<[f64;4]>=None;let mut rects=Vec::new();let mut translation=true;
    for (id,transform) in transforms{
        let node=doc.nodes.get(id)?;
        if node.mask { return None; }
        // A container pose stays local when this node itself does not filter.
        // Child support still comes from the same subtree bounds oracle; a
        // visible effect on the container can sample outside that proof.
        if !node.render_children().is_empty() && node.effects.iter().any(|e| e.visible) { return None; }
        let has_effects = node.effects.iter().any(|e| e.visible);
        if has_effects && (node.kind != "vector" || node.blend != "normal" || node.path_offset != 0. ||
            node.vector_brush.is_some() || node.derived_path.is_some() || node.strokes.iter().any(|s| s.visible) ||
            !node.fills.iter().any(|p| p.visible) ||
            node.effects.iter().any(|e| e.visible && e.kind != "inner-shadow")) { return None; }
        let ancestors:Vec<_>=parents.ancestors(id).collect();let mut matrix=Transform::default();
        for id in ancestors.into_iter().rev(){
            let n=doc.nodes.get(id)?;
            if n.mask||n.effects.iter().any(|e|e.visible)||n.boolean_operation.is_some(){return None}
            matrix=matrix.concat(n.transform);
        }
        let bounds = if has_effects {
            // An inner shadow multiplies its coverage by the original plane's
            // alpha. Even a stack cannot paint outside the filled path. Its
            // sampling support is still required when rasterizing these pixels.
            let (path, _) = node.paths().ok()?;
            let support = |pose| {
                let b = crate::bounds::path_bounds(&path, matrix.concat(pose))?;
                Some([b.x - 2., b.y - 2., b.x + b.width + 2., b.y + b.height + 2.])
            };
            [support(node.transform)?, support(*transform)?]
        } else {
            let before=subtree_bounds_from(doc,id,matrix,Some(fonts),false)?;
            let mut next=node.clone();next.transform=*transform;
            let after=subtree_bounds_node_observed(doc,id,matrix,Some(fonts),false,false,&mut|_,_|true,Some(&next))?;
            [before,after]
        };
        for bounds in bounds {
            if bounds.iter().any(|v|!v.is_finite()||v.abs()>1e9){return None}
            if let Some(union)=&mut union{union_box(union,bounds)}else{union=Some(bounds)}
            rects.push([bounds[0],bounds[1],bounds[2]-bounds[0],bounds[3]-bounds[1]]);
        }
        translation&=node.transform.0[..4].iter().zip(transform.0).all(|(a,b)|a.to_bits()==b.to_bits());
    }
    let bounds=union?;
    Some(PatchDamage{full:false,reason:None,bounds:Some([bounds[0],bounds[1],bounds[2]-bounds[0],bounds[3]-bounds[1]]),
        rects:Some(rects),translation_only:translation.then_some(true)})
}

/// Backdrops read their nearest isolated ancestor (or page). An edit in a
/// different scope cannot reach them. Ancestor edits remain conservative since
/// they may change isolation or move the entire dependent subtree.
fn backdrop_reads_edited_scope(
    doc: &Document,
    parents: &BTreeMap<&str, &str>,
    backdrop: &str,
    edited: &[&str],
) -> bool {
    let mut root = backdrop;
    let scope = loop {
        if let Some(parent) = parents.get(root).copied() {
            if doc.nodes.get(parent).is_none_or(|n| !n.passes_backdrop()) { break Some(parent); }
            root = parent;
        } else {
            break doc.pages.iter().find(|p|p.children.iter().any(|id|id==root)).map(|p|p.id.as_str());
        }
    };
    let Some(scope) = scope else { return true; };
    let contains = |ancestor: &str, child: &str| {
        let mut at = child;
        loop {
            if at == ancestor { return true; }
            if let Some(parent) = parents.get(at).copied() { at = parent; }
            else { return doc.pages.iter().any(|p|p.id==ancestor&&p.children.iter().any(|id|id==at)); }
        }
    };
    edited.iter().any(|id| doc.nodes.contains_key(*id) && (contains(scope,id) || contains(id,scope)))
}

pub(crate) fn has_unbounded_backdrop_for_patch(doc: &Document, patch: &crate::editing::DocumentPatch) -> bool {
    let lenses: Vec<_> = doc.nodes.iter().filter(|(_,n)| n.backdrop_effect().is_some_and(|e|e.kind!="background-blur")).collect();
    if lenses.is_empty() { return false; }
    let parents = parent_index(doc);
    let edited: Vec<_> = patch.nodes.keys().map(String::as_str).collect();
    lenses.into_iter().any(|(id,_)|backdrop_reads_edited_scope(doc,&parents,id,&edited))
}

fn patch_damage_impl(
    before: &Document,
    after: &Document,
    patch: &crate::editing::DocumentPatch,
    fonts: Option<&Fonts>,
    resolved_material: bool,
) -> PatchDamage {
    let full = |reason: &'static str| PatchDamage {
        translation_only: None,
        full: true,
        reason: Some(reason),
        bounds: None,
        rects: None,
    };
    // Doc-level state repaints everything when it *changes*: colour
    // settings, the design system (shared styles/variables), animation
    // clips, and any structural field beyond the document name. The mere
    // presence of colour settings, inert Sketch source metadata, or
    // animation clips does not make a local edit global.
    if before.color_management != after.color_management {
        return full("doc-level:color-management");
    }
    if before.design_system != after.design_system {
        return full("doc-level:design-system");
    }
    if before.animations != after.animations {
        return full("doc-level:animations-changed");
    }
    if patch
        .fields
        .keys()
        .any(|k| !matches!(k.as_str(), "name" | "reviews"))
    {
        return full("doc-level:structural-field");
    }
    let edited_ids: Vec<&str> = patch.nodes.keys().map(String::as_str).collect();
    let same_document = std::ptr::eq(before, after);
    let scoped_pages = edited_pages(before, &edited_ids).and_then(|mut pages| {
        if same_document { return Some(pages); }
        let after_pages = edited_pages(after, &edited_ids)?;
        pages.extend(after_pages);
        Some(pages)
    });
    let before_context = DamageContext::new(before, scoped_pages.as_ref());
    let after_context = (!same_document).then(|| DamageContext::new(after, scoped_pages.as_ref()));
    let parents_before = &before_context.parents;
    let parents_after = &after_context.as_ref().unwrap_or(&before_context).parents;
    // An edit can only repaint outside its own subtree when geometry
    // propagates up the ancestor chain: an auto-layout frame reflows when a
    // descendant's outer size changes, and a hug-sized frame resizes with
    // its content. Constraints reposition a child only after its parent
    // resizes, which itself requires such a chain — so the edited node's
    // own layout/constraints never escape its subtree bounds, and a layout
    // frame elsewhere in the document cannot move a pixel of this edit.
    // The previous whole-document gate turned every real scene containing a
    // single auto-layout frame into a full repaint per keystroke.
    let propagation_chain = |doc: &Document, parents: &BTreeMap<&str, &str>, id: &str| {
        let mut current = parents.get(id).copied();
        while let Some(node_id) = current {
            let Some(node) = doc.nodes.get(node_id) else {
                return true;
            };
            if node.layout.is_some()
                || node.sizing.as_ref().is_some_and(|s| {
                    matches!(s.width, crate::layout::SizeMode::Hug)
                        || matches!(s.height, crate::layout::SizeMode::Hug)
                })
            {
                return true;
            }
            current = parents.get(node_id).copied();
        }
        false
    };
    // Component definitions are mirrored into every instance, so editing
    // one repaints wherever instances live. Instance edits apply inside the
    // instance's own subtree and stay bounded by its before/after bounds.
    let component_definition =
        |doc: &Document, id: &str| {
            doc.nodes
                .get(id)
                .is_some_and(|n| n.component.is_some() || n.component_set)
        };
    // Connectors redraw outside the edited subtree when an attached endpoint
    // moves. Ordinary backdrop blur has finite read support in the
    // propagation below; glass/refraction keeps the full fallback until its
    // nonlocal sampling dependency has a separate certificate.
    let edited: Vec<&str> = edited_ids;
    let glass = |doc: &Document, parents: &BTreeMap<&str, &str>| {
        let mut hit = false;
        let _ = each_page_node(doc, scoped_pages.as_ref(), |id, n| {
            if n.backdrop_effect().is_some_and(|e| e.kind != "background-blur") &&
                backdrop_reads_edited_scope(doc, parents, id, &edited) { hit = true; return false; }
            true
        });
        hit
    };
    fn attached_endpoints<'a>(doc: &'a Document, pages: Option<&std::collections::BTreeSet<&str>>) -> Vec<&'a str> {
        let mut endpoints = Vec::new();
        let _ = each_page_node(doc, pages, |_id, n| {
            if let Some(connector) = &n.connector {
                if let Some(id) = connector.from.node_id.as_deref() { endpoints.push(id); }
                if let Some(id) = connector.to.node_id.as_deref() { endpoints.push(id); }
            }
            true
        });
        endpoints.sort_unstable();
        endpoints.dedup();
        endpoints
    }
    let attached_before = attached_endpoints(before, scoped_pages.as_ref());
    let attached_after = attached_endpoints(after, scoped_pages.as_ref());
    if scoped_pages.as_ref().is_some_and(|pages|
        foreign_connector_targets(before, pages, &parents_before, &edited) ||
        foreign_connector_targets(after, pages, &parents_after, &edited)) {
        return full("attached-endpoint");
    }
    if glass(before, &parents_before) || glass(after, &parents_after) {
        // Non-background-blur backdrop sampling has no finite read
        // certificate yet.
        return full("glass-effect");
    }
    for id in &edited {
        if component_definition(before, id) || component_definition(after, id) {
            return full("component-definition");
        }
        if !resolved_material && (propagation_chain(before, &parents_before, id)
            || propagation_chain(after, &parents_after, id))
        {
            return full("propagation-chain");
        }
        if attached_before
            .iter()
            .any(|ep| inside_edited_subtree(&parents_before, ep, id))
            || attached_after
                .iter()
                .any(|ep| inside_edited_subtree(&parents_after, ep, id))
        {
            return full("attached-endpoint");
        }
    }
    // A mask re-clips its following siblings, so an edit inside a masked
    // chain (or on the mask itself) must repaint the whole chain — bounded
    // subtree damage cannot express that.
    let masked_chain = |doc: &Document, parents: &BTreeMap<&str, &str>, id: &str| {
        let mut current = Some(id);
        while let Some(node_id) = current {
            if doc.nodes.get(node_id).is_some_and(|n| n.mask) &&
                (!resolved_material || parents.get(node_id).and_then(|parent|doc.nodes.get(*parent)).is_none()) {
                return true;
            }
            current = parents.get(node_id).copied();
        }
        false
    };
    // A resolved material edit cannot move a mask or its consumers. The
    // ancestor accumulation below encloses the entire consuming container.
    // Page-root masks have no such container and retain the full fallback.
    if patch.nodes.keys().any(|id| {
        masked_chain(before, &parents_before, id) || masked_chain(after, &parents_after, id)
    }) {
        return full("masked-chain");
    }
    let ops: Vec<_> = patch
        .nodes
        .keys()
        .map(|id| Op::SetTransform {
            id: id.clone(),
            matrix: Transform::default().0,
        })
        .collect();
    if ops.is_empty() {
        return PatchDamage {
            translation_only: None,
            full: false,
            reason: None,
            bounds: None,
            rects: None,
        };
    }
    let before_map = before_context.including_pages();
    let after_map = after_context.as_ref().unwrap_or(&before_context).including_pages();
    let region = dirty_region_prepared(
        before,
        after,
        &ops,
        &TileGrid::new(1., [0.; 2], 512),
        [-1e9, -1e9, 2e9, 2e9],
        fonts,
        &before_map,
        &after_map,
        scoped_pages.as_ref(),
    );
    if region.full {
        return full(region.reason.unwrap_or("dirty-region:unbounded"));
    }
    let bounds = region
        .world_bounds
        .filter(|b| b.iter().all(|v| v.is_finite()) && b[2] >= 0. && b[3] >= 0.);
    if bounds.is_none() {
        return full("dirty-region:invalid-bounds");
    }
    PatchDamage {
        translation_only: None,
        full: false,
        reason: None,
        bounds,
        rects: Some(region.world_rects),
    }
}

impl DirtyRegion {
    fn everything(reason: &'static str) -> Self {
        DirtyRegion {
            full: true,
            reason: Some(reason),
            world_bounds: None,
            world_rects: Vec::new(),
            tiles: Vec::new(),
        }
    }
}

fn full() -> DirtyRegion {
    DirtyRegion {
        full: false,
        reason: None,
        // Empty union sentinel: min corners at +inf, max corners at -inf.
        world_bounds: Some([
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ]),
        world_rects: Vec::new(),
        tiles: Vec::new(),
    }
}

#[cfg(test)]
std::thread_local! {
    // A source-construction counter, not physical allocation or elapsed time.
    static PARENT_MAP_CONSTRUCTIONS: std::cell::Cell<usize> = std::cell::Cell::new(0);
    static INDEXED_NODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(not(test))]
fn note_indexed() {}
#[cfg(test)]
fn note_indexed() { INDEXED_NODES.with(|count| count.set(count.get() + 1)); }

/// child id -> parent id, from page children lists and node children lists.
fn parent_map_pages<'a>(doc: &'a Document, only: Option<&std::collections::BTreeSet<&'a str>>) -> BTreeMap<&'a str, &'a str> {
    #[cfg(test)]
    PARENT_MAP_CONSTRUCTIONS.with(|count| count.set(count.get() + 1));
    let mut map = BTreeMap::new();
    for page in &doc.pages {
        if only.is_some_and(|pages| !pages.contains(page.id.as_str())) { continue; }
        for child in &page.children { map.insert(child.as_str(), page.id.as_str()); }
        if let Some(node) = doc.nodes.get(&page.id) {
            for child in &node.children { map.insert(child.as_str(), page.id.as_str()); }
        }
        let mut stack: Vec<&str> = page.children.iter().map(String::as_str).collect();
        while let Some(id) = stack.pop() {
            let Some(node) = doc.nodes.get(id) else { continue; };
            note_indexed();
            for child in &node.children {
                map.insert(child.as_str(), id);
                stack.push(child.as_str());
            }
        }
    }
    map
}
fn parent_map(doc: &Document) -> BTreeMap<&str, &str> {
    #[cfg(test)]
    PARENT_MAP_CONSTRUCTIONS.with(|count| count.set(count.get() + 1));
    fn add<'a>(map: &mut BTreeMap<&'a str, &'a str>, children: &'a [String], parent: &'a str) {
        for child in children {
            map.insert(child.as_str(), parent);
        }
    }
    let mut map = BTreeMap::new();
    for page in &doc.pages {
        add(&mut map, &page.children, &page.id);
        if let Some(node) = doc.nodes.get(&page.id) {
            add(&mut map, &node.children, &page.id);
        }
    }
    for (id, node) in &doc.nodes {
        add(&mut map, &node.children, id);
    }
    map
}

/// Effect support in page units, using the compiler's existing halo policy.
/// Effects consume the completed subtree, not just the node's own geometry.
fn effect_margin(n: &Node, m: Transform) -> f64 {
    n.effect_outset(m.max_scale())
}

/// Stroke allowance belongs only to this node's paths. Keep it separate from
/// effect support so neutral ancestors do not pad every descendant again.
fn stroke_margin(n: &Node, m: Transform) -> f64 {
    let mut strokes: f64 = 0.;
    for stroke in n.strokes.iter().filter(|s| s.visible) {
        let width = crate::stroke::maximum_width(stroke) * 4. * m.max_scale();
        if !width.is_finite() {
            return f64::NAN;
        }
        strokes = strokes.max(width);
    }
    strokes
}

fn union_box(a: &mut [f64; 4], b: [f64; 4]) {
    a[0] = a[0].min(b[0]);
    a[1] = a[1].min(b[1]);
    a[2] = a[2].max(b[2]);
    a[3] = a[3].max(b[3]);
}

/// World-space bounds of `id`'s whole subtree in the revision `doc`. Each
/// node's effects expand the union of its own geometry and completed children.
/// Invisible nodes still contribute bounds when they might become the
/// difference between revisions; the caller unions both revisions.
fn subtree_bounds_from(doc:&Document,id:&str,matrix:Transform,fonts:Option<&Fonts>,device:bool)->Option<[f64;4]> {
    subtree_bounds_observed(doc,id,matrix,fonts,device,false,&mut|_,_|true)
}
/// Shared conservative geometry oracle, once per node. Only the new radial
/// filter's source planner needs this map; ordinary damage queries stay unchanged.
pub(crate) fn render_bounds_map(doc:&Document,roots:&[String],camera:Transform,fonts:&Fonts)
    ->Result<std::collections::HashMap<String,([f64;4],Transform)>,String> {
    let mut result=std::collections::HashMap::new();
    result.try_reserve(doc.nodes.len()).map_err(|_|"Zoom bounds allocation failed")?;
    for id in roots {
        let value=subtree_bounds_observed(doc,id,camera,Some(fonts),true,false,&mut|id,value|{
            if crate::render_cancellation::checkpoint().is_err(){return false}
            if let Some(value)=value {result.insert(id.to_owned(),value);} true
        });
        if value.is_none(){crate::render_cancellation::checkpoint()?;return Err("Unable to bound zoom source geometry".into())}
    }
    Ok(result)
}

fn subtree_bounds_observed<F: FnMut(&str, Option<([f64;4], Transform)>) -> bool>(
        doc: &Document,
        id: &str,
        matrix: Transform,
        fonts: Option<&Fonts>,
        device: bool,
        controls: bool,
        observe: &mut F,
    ) -> Option<[f64; 4]> {
        subtree_bounds_node_observed(doc,id,matrix,fonts,device,controls,observe,None)
}
fn subtree_bounds_node_observed<F: FnMut(&str, Option<([f64;4], Transform)>) -> bool>(
        doc:&Document,id:&str,matrix:Transform,fonts:Option<&Fonts>,device:bool,controls:bool,
        observe:&mut F,override_node:Option<&Node>,
    )->Option<[f64;4]>{
        if !observe(id,None) {return None;}
        let Some(node) = override_node.or_else(||doc.nodes.get(id)) else {
            return None;
        };
        let m = matrix.concat(node.transform);
        if !m.0.iter().all(|v| v.is_finite())
            || ![node.width, node.height].iter().all(|v| v.is_finite())
        {
            return None;
        }
        let corners = [
            m.point(crate::math::Point::new(0., 0.)),
            m.point(crate::math::Point::new(node.width, 0.)),
            m.point(crate::math::Point::new(0., node.height)),
            m.point(crate::math::Point::new(node.width, node.height)),
        ];
        let halo = effect_margin(node, m);
        // Preserve the original operation order for this node's geometry,
        // including leaves: p +/- ((halo + strokes) + 2).
        let margin = if device { halo.ceil() + stroke_margin(node,m).ceil() + 4. } else { halo + stroke_margin(node,m) + 2. };
        if !margin.is_finite() || !halo.is_finite() || halo < 0. {
            return None;
        }
        let mut bounds = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for p in corners {
            if !p.finite() {
                return None;
            }
            bounds[0] = bounds[0].min(p.x - margin);
            bounds[1] = bounds[1].min(p.y - margin);
            bounds[2] = bounds[2].max(p.x + margin);
            bounds[3] = bounds[3].max(p.y + margin);
        }
        // Include actual authored curve/glyph geometry as well as the
        // selection box. Curves and unwrapped text may extend outside W/H.
        // Page-background certificates may use a wider authored control hull.
        // Damage and zoom dependency oracles retain their original tight paths.
        // Unknown/generated curves keep the exact path builder below.
        let control = controls.then(||crate::geometry_support::leaf_control_bounds(node,m)).flatten();
        let paths = if let Some(actual)=control {
            let b=[f64::from(actual.x)-margin,f64::from(actual.y)-margin,
                f64::from(actual.right())+margin,f64::from(actual.bottom())+margin];
            if !b.iter().all(|v|v.is_finite()){return None}
            union_box(&mut bounds,b);None
        } else if node.kind == "text" {
            if node.text.is_empty() {
                None
            } else {
                let Some(fonts) = fonts else {
                    return None;
                };
                let Ok(path) = fonts.node_path_shared(node) else {
                    return None;
                };
                Some(crate::path::LocalPaths::Text(path))
            }
        } else {
            let Ok(paths) = node.paths() else {
                return None;
            };
            Some(crate::path::LocalPaths::Owned(paths))
        };
        if let Some(paths) = paths {
            let (fill,stroke)=paths.pair();
            for path in [fill, stroke] {
                if let Some(actual) = crate::bounds::path_bounds(&path, m) {
                    let b = [
                        actual.x - margin,
                        actual.y - margin,
                        actual.x + actual.width + margin,
                        actual.y + actual.height + margin,
                    ];
                    if !b.iter().all(|v| v.is_finite()) {
                        return None;
                    }
                    union_box(&mut bounds, b);
                }
            }
        }
        if !bounds.iter().all(|v| v.is_finite()) {
            return None;
        }
        // Preserve conservative clip handling: do not crop to a logical box,
        // which need not enclose the actual clip path. Children are already
        // in world units, including their own effects; never transform twice.
        let mut children: Option<[f64; 4]> = None;
        for child in &node.children {
            let child = subtree_bounds_observed(doc, child, m, fonts, device, controls, observe)?;
            if let Some(children) = &mut children {
                union_box(children, child);
            } else {
                children = Some(child);
            }
        }
        // Rendering composites children before applying foreground effects.
        // The own geometry already has this halo; only the completed child
        // union still needs it. Expansion distributes over union, without
        // changing the original leaf arithmetic or adding ancestor stroke/AA.
        // None avoids expanding an empty +/-infinity child sentinel.
        if let Some(children) = children {
            let halo = if device { halo.ceil() + 4. } else { halo };
            let expanded = [
                children[0] - halo,
                children[1] - halo,
                children[2] + halo,
                children[3] + halo,
            ];
            if !expanded.iter().all(|v| v.is_finite()) {
                return None;
            }
            union_box(&mut bounds, expanded);
        }
        if !(bounds[2]-bounds[0]).is_finite() || !(bounds[3]-bounds[1]).is_finite() {return None;}
        observe(id,Some((bounds,m))).then_some(bounds)
    }

fn subtree_bounds(
    doc: &Document,
    parents: &BTreeMap<&str, &str>,
    id: &str,
    fonts: Option<&Fonts>,
) -> Option<[f64; 4]> {
    let mut ancestors = Vec::new();
    let mut cursor = id;
    while let Some(parent) = parents.get(cursor) {
        let Some(node) = doc.nodes.get(*parent) else {
            break;
        };
        if ancestors.len() >= doc.nodes.len() {
            return None;
        }
        ancestors.push(node.transform);
        cursor = parent;
    }
    let matrix = ancestors
        .into_iter()
        .rev()
        .fold(Transform::default(), Transform::concat);
    subtree_bounds_from(doc, id, matrix, fonts, false)
}

/// An empty pass-through container contributes no pixels of its own. Its
/// selection rectangle is UI metadata, not paint support. Keep all compositing,
/// masking and generated-geometry boundaries on the ordinary subtree oracle.
fn sparse_paint_container(n: &Node) -> bool {
    matches!(n.kind.as_str(), "group" | "frame") && n.visible && n.opacity == 1.
        && n.blend == "pass-through" && !n.clip && !n.mask
        && n.fills.is_empty() && n.strokes.is_empty() && n.effects.is_empty()
        && n.layout.is_none() && n.sizing.is_none() && n.constraints.is_none()
        && n.instance.is_none() && n.component.is_none() && n.repeat.is_none()
        && n.boolean_operation.is_none() && n.connector.is_none()
        && n.vector_brush.is_none() && n.text_path.is_none() && n.path_offset == 0.
        && n.derived_path.is_none() && n.network.is_none() && n.vector_geometry.is_none()
        && n.board.is_none()
}

/// A root's selection box is included unconditionally in page_paint_rects.
/// If that lower bound already covers this whole output, the full proof
/// cannot supply a background texel here. Decline only this optional request;
/// never publish the small box as complete page support or cache it as None.
/// Use the same zero-translation arithmetic then translation as the cached
/// page proof, including its existing per-root margin operation order.
pub(crate) fn page_background_can_sample(doc:&Document,page:&str,camera:Transform,translation:[f64;2],output:crate::math::Rect)->bool {
    let Some(page)=doc.pages.iter().find(|p|p.id==page)else{return true};
    for id in &page.children {
        let Some(node)=doc.nodes.get(id)else{continue};
        if sparse_paint_container(node) { continue; }
        let m=camera.concat(node.transform);
        let halo=effect_margin(node,m);let margin=halo.ceil()+stroke_margin(node,m).ceil()+4.;
        if !halo.is_finite()||halo<0.||!margin.is_finite(){continue}
        let mut b=[f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY];
        for p in [crate::math::Point::new(0.,0.),crate::math::Point::new(node.width,0.),crate::math::Point::new(0.,node.height),crate::math::Point::new(node.width,node.height)] {
            let p=m.point(p);if !p.finite(){return true}
            b[0]=b[0].min(p.x-margin);b[1]=b[1].min(p.y-margin);b[2]=b[2].max(p.x+margin);b[3]=b[3].max(p.y+margin);
        }
        if b[0]+translation[0]<=f64::from(output.x)&&b[1]+translation[1]<=f64::from(output.y)&&
            b[2]+translation[0]>=f64::from(output.right())&&b[3]+translation[1]>=f64::from(output.bottom()){return false}
    }
    true
}

pub(crate) fn page_paint_support_known(doc:&Document)->bool {
    // Marker geometry has its own support; the generic stroke-width margin
    // cannot certify an arbitrarily extended marker as empty background.
    if crate::stroke::has_markers(doc) { return false; }
    if doc.nodes.values().any(|n|n.effects.iter().any(|e|e.visible&&!matches!(e.kind.as_str(),
        "blur"|"gaussian-blur"|"motion-blur"|"zoom-blur"|"color-controls"|"shadow"|"inner-shadow"|"background-blur"|"glass"|"noise"|"texture"))) {return false;}
    true
}
pub(crate) fn root_paint_rect(doc:&Document,id:&str,fonts:&Fonts,camera:Transform)->Option<[f64;4]> {
    subtree_bounds_observed(doc,id,camera,Some(fonts),true,true,&mut|_,_|crate::render_cancellation::checkpoint().is_ok())
        .filter(|b|b.iter().all(|v|v.is_finite()&&v.abs()<=16_000_000.))
}

/// Complete conservative page paint support at this exact physical sampling
/// scale. No viewport culling; unknown effects decline the certificate.
/// Extra device pixels cover rounding/filter neighbours through every ancestor.
pub(crate) fn page_paint_rects(doc:&Document,page:&str,fonts:&Fonts,camera:Transform)->Option<Vec<[f64;4]>> {
    if !page_paint_support_known(doc){return None}
    let page=doc.pages.iter().find(|p|p.id==page)?;
    let mut rects = Vec::new();
    let mut pending: Vec<_> = page.children.iter().rev().map(|id|(id.as_str(),camera)).collect();
    let mut visited = 0usize;
    while let Some((id, matrix)) = pending.pop() {
        crate::render_cancellation::checkpoint().ok()?;
        visited += 1;
        if visited > doc.nodes.len() { return None; }
        let node = doc.nodes.get(id)?;
        if sparse_paint_container(node) && rects.len()+pending.len()+node.children.len()<=4096 {
            let next = matrix.concat(node.transform);
            if !next.0.iter().all(|v|v.is_finite()) { return None; }
            pending.extend(node.children.iter().rev().map(|id|(id.as_str(),next)));
        } else {
            rects.push(subtree_bounds_observed(doc,id,matrix,Some(fonts),true,true,
                &mut|_,_|crate::render_cancellation::checkpoint().is_ok())?);
        }
    }
    rects.iter().all(|b|b.iter().all(|v|v.is_finite()&&v.abs()<=16_000_000.)).then_some(rects)
}

type BoundsCache = BTreeMap<String, Option<[f64; 4]>>;
fn cached_subtree_bounds(doc: &Document, parents: &BTreeMap<&str, &str>, id: &str,
    fonts: Option<&Fonts>, cache: &mut BoundsCache) -> Option<[f64; 4]> {
    if let Some(bounds) = cache.get(id) { return *bounds; }
    let bounds = subtree_bounds(doc, parents, id, fonts);
    cache.insert(id.to_owned(), bounds);
    bounds
}

/// True when changes inside this subtree can alter pixels across the whole
/// subtree: effects flatten descendants, and masks consume child content.
fn subtree_retemplates(node: &Node) -> bool {
    // Backdrop effects run before children; changing a child cannot change
    // the ancestor's already sampled backdrop. Foreground effects still can
    // spread child pixels across their container.
    node.effects.iter().any(|e| e.visible && !matches!(e.kind.as_str(), "background-blur" | "glass"))
        || node.mask || node.boolean_operation.is_some()
}

/// A changed backdrop can change a later background-blur layer, whose output
/// can in turn be read by another blur. Ignore drawing order conservatively:
/// fixed-point propagation may over-report, but never misses a read chain.
/// The same subtree/bleed bounds enclose the capture geometry and finite
/// filter support; each candidate activates at most once.
fn propagate_background_reads<'a>(
    before: &'a Document,
    after: &'a Document,
    region: &mut DirtyRegion,
    fonts: Option<&Fonts>,
    ops: &[Op],
    caches: &mut [BoundsCache; 2],
    parent_maps: Option<[&BTreeMap<&'a str, &'a str>; 2]>,
    pages: Option<&std::collections::BTreeSet<&'a str>>,
) -> bool {
    if region
        .world_bounds
        .is_some_and(|b| b[0] > b[2] || b[1] > b[3])
    {
        return true;
    }
    let docs = [before, after];
    // Reuse only this call's maps of these exact revisions. The separate
    // parent_index excludes page sentinels and is not interchangeable.
    let owned_parents;
    let parents = if let Some(parents) = parent_maps {
        parents
    } else {
        owned_parents = [parent_map(before), parent_map(after)];
        [&owned_parents[0], &owned_parents[1]]
    };
    let mut candidates = Vec::new();
    let edited: Vec<_> = ops.iter().flat_map(op_targets).collect();
    let mut failed = false;
    for (revision, doc) in docs.iter().enumerate() {
        if failed { break; }
        let ok = each_page_node(doc, pages, |id, node| {
            if !node.backdrop_effect().is_some_and(|e| e.kind == "background-blur") { return true; }
            let is_descendant = |edited: &str| {
                let mut cursor = Some(edited);
                while let Some(at) = cursor {
                    if at == id { return true; }
                    cursor = parents[revision].get(at).copied();
                }
                false
            };
            if ops.iter().flat_map(op_targets).all(is_descendant) { return true; }
            if !backdrop_reads_edited_scope(doc, parents[revision], id, &edited) { return true; }
            if candidates.len() >= 512 { failed = true; return false; }
            let Some(read) = cached_subtree_bounds(doc, parents[revision], id, fonts, &mut caches[revision]) else {
                failed = true;
                return false;
            };
            if !read.iter().all(|v| v.is_finite()) { failed = true; return false; }
            candidates.push((revision, id, read, false));
            true
        });
        if !ok { failed = true; }
    }
    if failed { return false; }
    loop {
        let mut expanded = false;
        for (revision, id, read, activated) in &mut candidates {
            if *activated {
                continue;
            }
            let Some(_) = region.world_bounds else {
                return false;
            };
            if region.world_rects.iter().any(|dirty| dirty[0] <= read[2]
                && dirty[0] + dirty[2] >= read[0]
                && dirty[1] <= read[3]
                && dirty[1] + dirty[3] >= read[1])
            {
                let op = Op::SetTransform {
                    id: (*id).into(),
                    matrix: Transform::default().0,
                };
                if !accumulate(docs[*revision], &parents[*revision], id, &op, region, fonts, &mut caches[*revision]) {
                    return false;
                }
                *activated = true;
                expanded = true;
            }
        }
        if !expanded {
            return true;
        }
    }
}

/// Validated clipped page-root translations already supply both old and new
/// output footprints. Internal masks cannot escape their unchanged root clip.
/// Propagate finite backdrop reads in the final scene: the removed root's old
/// output is already dirty, and all other read scopes retain their placement.
pub(crate) fn clipped_translation_damage(doc: &Document, rects: Vec<[f64;4]>, ids: Vec<String>, fonts: &Fonts) -> PatchDamage {
    let full=|reason|PatchDamage{translation_only:Some(true),full:true,reason:Some(reason),bounds:None,rects:None};
    if doc.pages.iter().flat_map(|p|&p.children).any(|id|doc.nodes[id].mask)
        || doc.nodes.values().any(|n|n.backdrop_effect().is_some_and(|e|e.kind!="background-blur")) {
        return full("unbounded-root-backdrop-dependency");
    }
    let mut region=DirtyRegion{full:false,reason:None,world_bounds:Some([f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY]),world_rects:Vec::new(),tiles:Vec::new()};
    for r in rects {
        let b=[r[0],r[1],r[0]+r[2],r[1]+r[3]];
        add_paint_rect(&mut region,b);union_box(region.world_bounds.as_mut().unwrap(),b);
    }
    if doc.nodes.values().any(|n|n.backdrop_effect().is_some()) {
        let ops:Vec<_>=ids.into_iter().map(|id|Op::SetTransform{id,matrix:Transform::default().0}).collect();
        if !propagate_background_reads(doc,doc,&mut region,Some(fonts),&ops,&mut Default::default(),None,None) {
            return full("unbounded-background-read");
        }
    }
    let b=region.world_bounds.unwrap();
    PatchDamage{translation_only:Some(true),full:false,reason:None,bounds:Some([b[0],b[1],b[2]-b[0],b[3]-b[1]]),rects:Some(region.world_rects)}
}

/// Ops that can move siblings inside an autolayout parent.
fn relayouts_siblings(op: &Op) -> bool {
    matches!(
        op,
        Op::ApplyFacet { .. } | Op::ClearFacet { .. } | Op::Resize { .. }
    )
}

fn op_targets(op: &Op) -> Vec<&str> {
    match op {
        Op::SetName { .. } => Vec::new(), // names do not rasterize
        Op::SetVisible { id, .. }
        | Op::SetOpacity { id, .. }
        | Op::SetTransform { id, .. }
        | Op::Resize { id, .. }
        | Op::ApplyFacet { id, .. }
        | Op::ClearFacet { id, .. } => vec![id],
        Op::InsertNode { node, .. } => vec![node.id.as_str()],
        Op::RemoveNode { id } => vec![id],
        Op::ReorderChild { parent, .. } => vec![parent],
    }
}

/// Derive the dirty region for applying `ops` to `before`, producing `after`.
///
/// * `viewport_world` — visible page-space rectangle `[x, y, w, h]`; tiles
///   outside it are dropped because no visible pixel changes.
///
/// Correctness rules, in order:
/// 1. Every op target is dirtied in **both** revisions (old and new footprint).
/// 2. Ancestors that retemplate their subtree (visible effects, mask
///    consumption) propagate child changes across their whole subtree.
/// 3. Autolayout parents propagate size/facet changes to shifted siblings.
/// 4. Anything unbounded → `full`.
pub fn dirty_region(
    before: &Document,
    after: &Document,
    ops: &[Op],
    grid: &TileGrid,
    viewport_world: [f64; 4],
) -> DirtyRegion {
    dirty_region_with_fonts(before, after, ops, grid, viewport_world, None)
}

fn dirty_region_with_fonts(
    before: &Document,
    after: &Document,
    ops: &[Op],
    grid: &TileGrid,
    viewport_world: [f64; 4],
    fonts: Option<&Fonts>,
) -> DirtyRegion {
    let before_parents = parent_map(before);
    let after_parents = parent_map(after);
    dirty_region_prepared(before, after, ops, grid, viewport_world, fonts, &before_parents, &after_parents, None)
}
fn dirty_region_prepared<'a>(
    before: &'a Document,
    after: &'a Document,
    ops: &[Op],
    grid: &TileGrid,
    viewport_world: [f64; 4],
    fonts: Option<&Fonts>,
    before_parents: &BTreeMap<&'a str, &'a str>,
    after_parents: &BTreeMap<&'a str, &'a str>,
    pages: Option<&std::collections::BTreeSet<&'a str>>,
) -> DirtyRegion {
    let mut region = full();
    let mut caches = [BoundsCache::new(), BoundsCache::new()];
    let mut missing = false;
    for op in ops {
        for id in op_targets(op) {
            let in_before = before.nodes.contains_key(id);
            let in_after = after.nodes.contains_key(id);
            if !in_before && !in_after {
                missing = true;
                continue;
            }
            if in_before && !accumulate(before, &before_parents, id, op, &mut region, fonts, &mut caches[0]) {
                return DirtyRegion::everything("non-finite geometry in prior revision");
            }
            if in_after && !accumulate(after, &after_parents, id, op, &mut region, fonts, &mut caches[1]) {
                return DirtyRegion::everything("non-finite geometry in updated revision");
            }
        }
    }
    if missing {
        return DirtyRegion::everything("op target missing from both revisions");
    }
    if !propagate_background_reads(before, after, &mut region, fonts, ops, &mut caches,
        Some([before_parents, after_parents]), pages) {
        return DirtyRegion::everything("unbounded background-blur dependency");
    }
    let Some(mut bounds) = region.world_bounds else {
        return DirtyRegion::everything("unbounded dirty derivation");
    };
    if bounds[0] > bounds[2] || bounds[1] > bounds[3] {
        // No visible targets at all: nothing changed on screen.
        return DirtyRegion {
            full: false,
            reason: None,
            world_bounds: Some([0.; 4]),
            world_rects: Vec::new(),
            tiles: Vec::new(),
        };
    }
    let world_bounds = [
        bounds[0],
        bounds[1],
        bounds[2] - bounds[0],
        bounds[3] - bounds[1],
    ];
    // Clip to the viewport before tiling: invisible changes produce no tiles.
    let x0 = bounds[0].max(viewport_world[0]);
    let y0 = bounds[1].max(viewport_world[1]);
    let x1 = bounds[2].min(viewport_world[0] + viewport_world[2]);
    let y1 = bounds[3].min(viewport_world[1] + viewport_world[3]);
    if x0 >= x1 || y0 >= y1 {
        return DirtyRegion {
            full: false,
            reason: None,
            world_bounds: Some(world_bounds),
            world_rects: region.world_rects.clone(),
            tiles: Vec::new(),
        };
    }
    bounds = [x0, y0, x1 - x0, y1 - y0];
    match raster_addresses(bounds, grid.zoom, grid.limit, grid.phase) {
        Ok(mut tiles) => {
            tiles.sort_unstable();
            tiles.dedup();
            DirtyRegion {
                full: false,
                reason: None,
                world_bounds: Some(world_bounds),
            world_rects: region.world_rects.clone(),
                tiles,
            }
        }
        Err(message) => DirtyRegion::everything(
            // Two failure modes share the raster_addresses error path; both
            // are budget/validation refusals, both degrade to a full repaint.
            if message.contains("budget") {
                "visible tile budget exceeded"
            } else {
                "invalid tile bounds"
            },
        ),
    }
}

fn add_paint_rect(region: &mut DirtyRegion, bounds: [f64; 4]) {
    let next = [bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]];
    if !region.world_rects.contains(&next) { region.world_rects.push(next); }
    if region.world_rects.len() > 256 {
        let mut union = bounds;
        for r in &region.world_rects { union_box(&mut union, [r[0], r[1], r[0]+r[2], r[1]+r[3]]); }
        region.world_rects = vec![[union[0],union[1],union[2]-union[0],union[3]-union[1]]];
    }
}

/// Union the footprint of `id` in one revision into `region`. Returns false
/// when the geometry cannot be bounded.
fn accumulate<'a>(
    doc: &'a Document,
    parents: &BTreeMap<&'a str, &'a str>,
    id: &str,
    op: &Op,
    region: &mut DirtyRegion,
    fonts: Option<&Fonts>,
    cache: &mut BoundsCache,
) -> bool {
    let Some(bounds) = cached_subtree_bounds(doc, parents, id, fonts, cache) else {
        return false;
    };
    add_paint_rect(region, bounds);
    region.world_bounds = region.world_bounds.map(|mut b| {
        union_box(&mut b, bounds);
        b
    });
    // Escalate through ancestors that retemplate their subtree: a child edit
    // inside an effect-bearing or mask-consuming container can change the
    // container's output across its whole footprint.
    let mut cursor = id;
    while let Some(parent) = parents.get(cursor) {
        // Page roots may or may not be nodes; above them there is no
        // container left that could retemplate the subtree.
        let Some(node) = doc.nodes.get(*parent) else {
            break;
        };
        if subtree_retemplates(node) || doc.mask_child(node).is_some() {
            let Some(bounds) = cached_subtree_bounds(doc, parents, parent, fonts, cache) else {
                return false;
            };
            add_paint_rect(region, bounds);
            region.world_bounds = region.world_bounds.map(|mut b| {
                union_box(&mut b, bounds);
                b
            });
        }
        cursor = parent;
    }
    // Autolayout containers shift siblings when a child resizes or changes a
    // layout facet; the whole container footprint is the honest bound.
    if relayouts_siblings(op)
        && let Some(parent) = parents.get(id)
        && doc
            .nodes
            .get(*parent)
            .is_some_and(|node| node.layout.is_some())
    {
        let Some(bounds) = cached_subtree_bounds(doc, parents, parent, fonts, cache) else {
            return false;
        };
        add_paint_rect(region, bounds);
        region.world_bounds = region.world_bounds.map(|mut b| {
            union_box(&mut b, bounds);
            b
        });
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(before: &Document, after: &Document) -> crate::editing::DocumentPatch {
        crate::editing::DocumentPatch::between(before, after).unwrap()
    }

    #[test]
    fn managed_source_metadata_is_local_but_resource_and_raster_changes_are_full() {
        let mut before = document(json!(["a", "b"]));
        before.color_management = Some(Default::default());
        before.design_system = Some(
            serde_json::from_value(json!({
                "sketchContainers": {"nodeMetadata": {"a": {"source": "preserved"}}}
            }))
            .unwrap(),
        );
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        let local = patch_damage(&before, &after, &patch(&before, &after));
        assert!(
            !local.full,
            "unchanged color and source metadata do not propagate a translation"
        );
        assert!(local.bounds.unwrap()[2] < 100.);

        let mut renamed = before.clone();
        renamed.name = "renamed".into();
        let clean = patch_damage(&before, &renamed, &patch(&before, &renamed));
        assert!(!clean.full);
        assert!(clean.bounds.is_none());
        for field in [
            "fonts",
            "colorManagement",
            "designSystem",
            "pages",
            "rasterProfile",
        ] {
            let mut changed = patch(&before, &after);
            changed.fields.insert(field.into(), json!(null));
            assert!(patch_damage(&before, &after, &changed).full, "{field}");
        }
        let mut styled = after.clone();
        styled
            .nodes
            .get_mut("b")
            .unwrap()
            .style_refs
            .insert("fill".into(), "shared".into());
        // A reference on an *unedited* node cannot propagate this edit: the
        // shared style itself lives in the design system, whose diff already
        // takes the full path above.
        let referenced = patch_damage(&before, &styled, &patch(&before, &styled));
        assert!(
            !referenced.full,
            "an unedited node's style reference does not globalize a local edit"
        );
    }

    #[test]
    fn autolayout_elsewhere_does_not_globalize_a_local_edit() {
        let mut before = document(json!(["a", "b"]));
        before.nodes.insert(
            "stack".into(),
            serde_json::from_value(json!({
                "id":"stack","kind":"frame","width":200.,"height":300.,
                "transform":[1.,0.,0.,1.,500.,20.],
                "fills":[{"kind":"solid","color":"#ffffff"}],
                "children":["s1","s2"]
            }))
            .unwrap(),
        );
        before.nodes.insert(
            "s1".into(),
            serde_json::from_value(json!({
                "id":"s1","kind":"rectangle","width":40.,"height":40.,
                "transform":[1.,0.,0.,1.,0.,0.],
                "fills":[{"kind":"solid","color":"#8844cc"}]
            }))
            .unwrap(),
        );
        before.nodes.insert(
            "s2".into(),
            serde_json::from_value(json!({
                "id":"s2","kind":"rectangle","width":40.,"height":40.,
                "transform":[1.,0.,0.,1.,0.,0.],
                "fills":[{"kind":"solid","color":"#44cc88"}]
            }))
            .unwrap(),
        );
        before.nodes.get_mut("stack").unwrap().layout =
            Some(crate::layout::Layout {
                mode: crate::layout::Flow::Vertical,
                ..Default::default()
            });
        before.pages[0].children.push("stack".into());
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        let damage = patch_damage(&before, &after, &patch(&before, &after));
        assert!(
            !damage.full,
            "an auto-layout frame outside the edited subtree cannot move its pixels"
        );
        assert!(damage.bounds.unwrap()[2] < 100.);
        assert_changed_pixels_inside(&before, &after, damage, None);
    }

    #[test]
    fn damage_index_ignores_cold_asset_pages() {
        let mut before = document(json!(["a", "b"]));
        let mut cold = Vec::new();
        for index in 0..200 {
            let id = format!("asset{index}");
            cold.push(id.clone());
            before.nodes.insert(id.clone(), serde_json::from_value(json!({
                "id": id, "kind": "rectangle", "width": 8., "height": 8.,
                "fills": [{"kind": "solid", "color": "#cccccc"}]
            })).unwrap());
        }
        before.pages.push(crate::scene::Page { guides: Vec::new(), id: "assets".into(), name: "assets".into(),
            children: cold, background: "#ffffff".into() });
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().fills[0].color = "#112233".into();
        INDEXED_NODES.with(|count| count.set(0));
        let damage = patch_damage(&before, &after, &patch(&before, &after));
        let indexed = INDEXED_NODES.with(|count| count.get());
        assert!(!damage.full, "{}", damage.reason.unwrap_or("local"));
        assert!(indexed < 40, "cold asset pages were indexed: {indexed}");
        assert_changed_pixels_inside(&before, &after, damage, None);
    }

    #[test]
    fn geometry_edit_inside_autolayout_frame_stays_full() {
        let mut before = document(json!(["a", "b"]));
        before.nodes.insert(
            "stack".into(),
            serde_json::from_value(json!({
                "id":"stack","kind":"frame","width":200.,"height":300.,
                "transform":[1.,0.,0.,1.,20.,20.],
                "fills":[{"kind":"solid","color":"#ffffff"}],
                "children":["s1"]
            }))
            .unwrap(),
        );
        before.nodes.insert(
            "s1".into(),
            serde_json::from_value(json!({
                "id":"s1","kind":"rectangle","width":40.,"height":40.,
                "transform":[1.,0.,0.,1.,0.,0.],
                "fills":[{"kind":"solid","color":"#8844cc"}]
            }))
            .unwrap(),
        );
        before.nodes.get_mut("stack").unwrap().layout =
            Some(crate::layout::Layout {
                mode: crate::layout::Flow::Vertical,
                ..Default::default()
            });
        before.pages[0].children.push("stack".into());
        // Resizing a child reflows the stack's siblings and possibly the
        // frame itself: bounded subtree damage cannot express that.
        let mut after = before.clone();
        after.nodes.get_mut("s1").unwrap().height = 120.;
        assert!(patch_damage(&before, &after, &patch(&before, &after)).full);
    }

    #[test]
    fn paint_edit_outside_layout_chains_is_bounded_even_with_layout_in_the_document() {
        let mut before = document(json!(["a", "b"]));
        before.nodes.insert(
            "stack".into(),
            serde_json::from_value(json!({
                "id":"stack","kind":"frame","width":200.,"height":300.,
                "transform":[1.,0.,0.,1.,600.,20.],
                "fills":[{"kind":"solid","color":"#ffffff"}],
                "children":["s1"]
            }))
            .unwrap(),
        );
        before.nodes.insert(
            "s1".into(),
            serde_json::from_value(json!({
                "id":"s1","kind":"rectangle","width":40.,"height":40.,
                "transform":[1.,0.,0.,1.,0.,0.],
                "fills":[{"kind":"solid","color":"#8844cc"}]
            }))
            .unwrap(),
        );
        before.nodes.get_mut("stack").unwrap().layout =
            Some(crate::layout::Layout {
                mode: crate::layout::Flow::Vertical,
                ..Default::default()
            });
        before.pages[0].children.push("stack".into());
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().fills[0].color = "#cc4488".into();
        let damage = patch_damage(&before, &after, &patch(&before, &after));
        assert!(
            !damage.full,
            "a repaint outside every layout chain stays local even though the document contains an auto-layout frame"
        );
        let bounds = damage.bounds.unwrap();
        assert!(
            bounds[0] < 30. && bounds[0] + bounds[2] > 80.,
            "damage hugs the repainted rectangle: {bounds:?}"
        );
        assert_changed_pixels_inside(&before, &after, damage, None);
        // The same paint change on the child INSIDE the stack keeps the full
        // path: the solver positions children, so authored subtree bounds
        // cannot certify rendered pixels under a layout ancestor.
        let mut inside = before.clone();
        inside.nodes.get_mut("s1").unwrap().fills[0].color = "#cc4488".into();
        assert!(patch_damage(&before, &inside, &patch(&before, &inside)).full);
    }

    #[test]
    fn component_definition_edits_are_full_but_instance_edits_stay_local() {
        let mut before = document(json!(["a", "b"]));
        before.nodes.get_mut("a").unwrap().component =
            Some(serde_json::from_value(json!({
                "variants": {}, "properties": {}
            }))
            .unwrap());
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        assert!(
            patch_damage(&before, &after, &patch(&before, &after)).full,
            "every instance mirrors a component definition edit"
        );
        let mut instance_doc = document(json!(["a", "b"]));
        instance_doc.nodes.insert(
            "main".into(),
            serde_json::from_value(json!({
                "id":"main","kind":"frame","width":60.,"height":40.,
                "transform":[1.,0.,0.,1.,24.,500.],
                "fills":[{"kind":"solid","color":"#4477dd"}],
                "component":{"variants":{},"properties":{}}
            }))
            .unwrap(),
        );
        instance_doc.pages[0].children.push("main".into());
        instance_doc.nodes.get_mut("b").unwrap().instance =
            Some(serde_json::from_value(json!({
                "componentId": "main", "overrides": {}, "propertyValues": {}
            }))
            .unwrap());
        // Component resolution mirrors the definition into the instance, so
        // the instance's own authored fills do not rasterize; a plain-node
        // edit in the same document must stay bounded regardless.
        let mut instance_after = instance_doc.clone();
        instance_after.nodes.get_mut("a").unwrap().fills[0].color = "#112233".into();
        let damage = patch_damage(&instance_doc, &instance_after, &patch(&instance_doc, &instance_after));
        assert!(
            !damage.full,
            "instances elsewhere in the document do not globalize a plain edit"
        );
        assert_changed_pixels_inside(&instance_doc, &instance_after, damage, None);
    }

    #[test]
    fn connector_attached_to_an_edited_subtree_is_full() {
        let mut before = document(json!(["a", "b"]));
        before.nodes.insert(
            "wire".into(),
            serde_json::from_value(json!({
                "id":"wire","kind":"rectangle","width":60.,"height":4.,
                "transform":[1.,0.,0.,1.,200.,200.],
                "fills":[],"strokes":[{"width":2.,"paint":{"kind":"solid","color":"#333333"},"visible":true,"aligned":"center"}],
                "connector":{"from":{"point":{"x":10.,"y":10.},"nodeId":"a"},
                              "to":{"point":{"x":90.,"y":10.},"nodeId":"b"},
                              "style":"straight"}
            }))
            .unwrap(),
        );
        before.pages[0].children.push("wire".into());
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        assert!(
            patch_damage(&before, &after, &patch(&before, &after)).full,
            "moving an attached endpoint reroutes the connector outside the subtree"
        );
        // The same document with the wire attached only to untouched nodes
        // keeps the local proof.
        let mut detached = before.clone();
        let connector = detached.nodes.get_mut("wire").unwrap();
        connector.connector = Some(
            serde_json::from_value(json!({
                "from":{"point":{"x":10.,"y":10.},"nodeId":"b"},
                "to":{"point":{"x":90.,"y":10.},"nodeId":"b"},
                "style":"straight"
            }))
            .unwrap(),
        );
        let mut detached_after = detached.clone();
        detached_after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        let damage = patch_damage(&detached, &detached_after, &patch(&detached, &detached_after));
        assert!(!damage.full);
        assert!(damage.bounds.unwrap()[2] < 100.);
    }

    #[test]
    fn curve_geometry_outside_selection_box_is_included_in_local_damage() {
        let mut before = document(json!(["a", "b"]));
        before.schema_version = 5;
        let node = before.nodes.get_mut("a").unwrap();
        node.kind = "vector".into();
        node.width = 1.;
        node.height = 1.;
        node.network = Some(
            serde_json::from_value(json!({
                "vertices": [{"id":"v0","x":80.,"y":0.},{"id":"v1","x":120.,"y":0.},
                    {"id":"v2","x":100.,"y":30.}],
                "edges": [{"id":"e0","from":"v0","to":"v1"},
                    {"id":"e1","from":"v1","to":"v2"},{"id":"e2","from":"v2","to":"v0"}]
            }))
            .unwrap(),
        );
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        let damage = patch_damage(&before, &after, &patch(&before, &after));
        assert!(!damage.full);
        let b = damage.bounds.unwrap();
        assert!(
            b[0] + b[2] >= 168.,
            "actual path extent plus new transform: {b:?}"
        );
        assert_changed_pixels_inside(&before, &after, damage, None);
    }

    #[test]
    fn actual_loaded_font_bounds_cover_unwrapped_glyphs_and_changed_pixels() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap();
        let mut fonts = Fonts::new();
        fonts.load(&bytes).unwrap();
        let mut before = document(json!(["a", "b"]));
        before.schema_version = 5;
        before.color_management = Some(Default::default());
        let node = before.nodes.get_mut("a").unwrap();
        node.kind = "text".into();
        node.text = "MMMMMM".into();
        node.font_size = 24.;
        node.width = 1.;
        node.height = 1.;
        node.text_style = Some(serde_json::from_value(json!({"wrap":false})).unwrap());
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        let patch = patch(&before, &after);
        assert!(
            patch_damage(&before, &after, &patch).full,
            "missing actual font cannot certify logical text bounds"
        );
        let damage = patch_damage_with_fonts(&before, &after, &patch, &fonts);
        assert!(!damage.full);
        assert!(
            damage.bounds.unwrap()[2] > 100.,
            "glyphs overflow their 1-unit selection box"
        );
        assert_changed_pixels_inside(&before, &after, damage, Some(&bytes));
    }

    fn add_background_blur(doc: &mut Document, id: &str, x: f64, width: f64) {
        doc.schema_version = 5;
        doc.nodes.insert(
            id.into(),
            serde_json::from_value(json!({
                "id":id,"kind":"rectangle","width":width,"height":60.,
                "transform":[1.,0.,0.,1.,x,20.],
                "fills":[{"kind":"solid","color":"#ffffff","opacity":0.2}],
                "effects":[{"kind":"background-blur","radius":8.,"color":"#000000"}]
            }))
            .unwrap(),
        );
        doc.pages[0].children.push(id.into());
    }

    #[test]
    fn distant_background_blur_does_not_make_a_local_edit_global() {
        let mut before = document(json!(["a", "b"]));
        before.color_management = Some(Default::default());
        add_background_blur(&mut before, "lens", 400., 80.);
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        let damage = patch_damage(&before, &after, &patch(&before, &after));
        assert!(!damage.full);
        assert!(
            damage.bounds.unwrap()[2] < 100.,
            "unread pixels remain outside damage"
        );
        assert_changed_pixels_inside(&before, &after, damage, None);
    }

    #[test]
    fn isolated_board_backdrops_do_not_read_external_damage_but_pass_through_does() {
        for passthrough in [false, true] {
            let mut before = document(json!(["a", "b"]));
            before.color_management = Some(Default::default());
            add_background_blur(&mut before, "lens", 90., 80.);
            before.pages[0].children.retain(|id| id != "lens");
            before.pages[0].children.push("board".into());
            before.nodes.insert("board".into(), serde_json::from_value(json!({
                "id":"board","kind":"frame","width":240,"height":100,
                "blend":if passthrough {"pass-through"} else {"normal"},
                "opacity":0.8,"children":["lens"]
            })).unwrap());
            let mut after = before.clone();
            after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
            let damage = patch_damage(&before, &after, &patch(&before, &after));
            assert!(!damage.full);
            let end = damage.bounds.unwrap()[0] + damage.bounds.unwrap()[2];
            assert_eq!(end > 150., passthrough, "isolation must determine the read scope");
            assert_changed_pixels_inside(&before, &after, damage, None);
        }
    }

    #[test]
    fn internal_edits_still_propagate_to_internal_background_reads() {
        let mut before = document(json!(["a"]));
        before.color_management = Some(Default::default());
        add_background_blur(&mut before,"lens",90.,80.);
        before.pages[0].children=vec!["board".into(),"b".into()];
        before.nodes.insert("board".into(),serde_json::from_value(json!({
            "id":"board","kind":"frame","width":240,"height":100,"children":["a","lens"]
        })).unwrap());
        let mut after=before.clone();after.nodes.get_mut("a").unwrap().transform.0[4]+=24.;
        let damage=patch_damage(&before,&after,&patch(&before,&after));
        assert!(!damage.full);
        assert!(damage.bounds.unwrap()[0]+damage.bounds.unwrap()[2]>150.);
        assert_changed_pixels_inside(&before,&after,damage,None);
    }

    #[test]
    fn child_edits_do_not_invalidate_the_ancestors_prior_backdrop_pass() {
        let mut before=document(json!(["b","board"]));
        before.schema_version=5;
        before.color_management=Some(Default::default());
        before.nodes.insert("board".into(),serde_json::from_value(json!({
            "id":"board","kind":"frame","width":200,"height":90,"children":["a"],
            "effects":[{"kind":"background-blur","radius":8,"color":"#000000"}]
        })).unwrap());
        let mut after=before.clone();after.nodes.get_mut("a").unwrap().transform.0[4]+=24.;
        let damage=patch_damage(&before,&after,&patch(&before,&after));
        assert!(!damage.full);assert!(damage.bounds.unwrap()[2]<100.);
        assert_changed_pixels_inside(&before,&after,damage,None);
        let mut external=before.clone();external.nodes.get_mut("b").unwrap().transform.0[4]=50.;
        external.nodes.get_mut("b").unwrap().transform.0[5]=20.;
        let damage=patch_damage(&before,&external,&patch(&before,&external));
        assert!(damage.bounds.unwrap()[2]>200.);
        assert_changed_pixels_inside(&before,&external,damage,None);
    }

    #[test]
    fn separated_old_and_new_footprints_do_not_dirty_a_blur_in_the_gap() {
        let mut before=document(json!(["a","b"]));
        add_background_blur(&mut before,"gap",500.,80.);
        let mut after=before.clone();after.nodes.get_mut("a").unwrap().transform.0[4]=1200.;
        let damage=patch_damage(&before,&after,&patch(&before,&after));
        assert!(!damage.full);
        let rects=damage.rects.unwrap();
        assert_eq!(rects.len(),2);
        assert!(!rects.iter().any(|r|r[0]<=550.&&r[0]+r[2]>=550.));
    }

    #[test]
    fn overlapping_background_reads_propagate_through_the_entire_blur_chain() {
        let mut before = document(json!(["a", "b"]));
        before.color_management = Some(Default::default());
        add_background_blur(&mut before, "lens-a", 90., 80.);
        add_background_blur(&mut before, "lens-b", 164., 70.);
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        let damage = patch_damage(&before, &after, &patch(&before, &after));
        assert!(!damage.full);
        let bounds = damage.bounds.unwrap();
        assert!(
            bounds[0] + bounds[2] >= 252.,
            "second blur output must be repainted: {bounds:?}"
        );
        let changed_right = assert_changed_pixels_inside(&before, &after, damage, None);
        assert!(
            changed_right > after.nodes["a"].transform.0[4] + after.nodes["a"].width + 2.,
            "the real backdrop must change pixels beyond the source's own damage footprint"
        );
    }

    #[test]
    fn glass_sampling_still_revokes_local_proofs() {
        let mut before = document(json!(["a", "b"]));
        add_background_blur(&mut before, "lens", 400., 80.);
        let effect = &mut before.nodes.get_mut("lens").unwrap().effects[0];
        effect.kind = "glass".into();
        effect.amount = 2.;
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        assert!(patch_damage(&before, &after, &patch(&before, &after)).full);
    }

    #[test]
    fn animation_presence_does_not_globalize_a_local_edit() {
        let mut before = document(json!(["a", "b"]));
        before.animations = vec![serde_json::from_value(json!({
            "id": "clip-1", "name": "slide", "pageId": "p", "durationMs": 600.,
            "tracks": [{"nodeId": "b", "keyframes": [
                {"timeMs": 0., "value": {"kind": "transform", "transform": [1.,0.,0.,1.,0.,0.],
                    "width": 40., "height": 40., "opacity": 1., "radii": [0.,0.,0.,0.],
                    "smoothing": 0., "fills": [], "strokes": [], "effects": []}},
                {"timeMs": 600., "value": {"kind": "transform", "transform": [1.,0.,0.,1.,100.,0.],
                    "width": 40., "height": 40., "opacity": 1., "radii": [0.,0.,0.,0.],
                    "smoothing": 0., "fills": [], "strokes": [], "effects": []}}
            ]}]
        }))
        .unwrap()];
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] += 24.;
        let damage = patch_damage(&before, &after, &patch(&before, &after));
        assert!(
            !damage.full,
            "unchanged animation clips do not globalize an unrelated edit"
        );
        assert!(damage.bounds.unwrap()[2] < 100.);
    }

    #[test]
    fn animation_changes_are_full() {
        let mut before = document(json!(["a", "b"]));
        before.animations = vec![serde_json::from_value(json!({
            "id": "clip-1", "name": "slide", "pageId": "p", "durationMs": 600.,
            "tracks": [{"nodeId": "a", "keyframes": [
                {"timeMs": 0., "value": {"kind": "transform", "transform": [1.,0.,0.,1.,0.,0.],
                    "width": 60., "height": 40., "opacity": 1., "radii": [0.,0.,0.,0.],
                    "smoothing": 0., "fills": [], "strokes": [], "effects": []}}
            ]}]
        }))
        .unwrap()];
        let mut added = before.clone();
        added.animations.push(
            serde_json::from_value(json!({
                "id": "clip-2", "name": "fade", "pageId": "p", "durationMs": 300.,
                "tracks": []
            }))
            .unwrap(),
        );
        let damage = patch_damage(&before, &added, &patch(&before, &added));
        assert!(damage.full, "adding a clip repaints everywhere");
        assert_eq!(damage.reason, Some("doc-level:animations-changed"));
        let removed = patch_damage(&added, &before, &patch(&added, &before));
        assert!(removed.full, "removing a clip repaints everywhere");
        assert_eq!(removed.reason, Some("doc-level:animations-changed"));
        let mut retimed = before.clone();
        retimed.animations[0].duration_ms = 900.;
        assert!(
            patch_damage(&before, &retimed, &patch(&before, &retimed)).full,
            "editing a clip repaints everywhere"
        );
    }

    fn assert_changed_pixels_inside(
        before: &Document,
        after: &Document,
        damage: PatchDamage,
        font: Option<&[u8]>,
    ) -> f64 {
        let mut engine = crate::renderer::Engine::new();
        if let Some(font) = font {
            engine.load_font(font).unwrap();
        }
        let options = serde_json::from_value(json!({"pageId":"p","width":224,"height":96,
            "view":{"x":0.,"y":0.,"zoom":1.},"rasterProfile":"analytic"}))
        .unwrap();
        engine
            .load_document(&serde_json::to_string(before).unwrap())
            .unwrap();
        let a = engine.render(&options).unwrap();
        engine
            .load_document(&serde_json::to_string(after).unwrap())
            .unwrap();
        let b = engine.render(&options).unwrap();
        let bounds = damage.bounds.unwrap();
        let mut changed = 0;
        let mut changed_right = f64::NEG_INFINITY;
        for (i, (a, b)) in a.chunks_exact(4).zip(b.chunks_exact(4)).enumerate() {
            if a != b {
                changed += 1;
                let x = (i % 224) as f64;
                let y = (i / 224) as f64;
                changed_right = changed_right.max(x);
                assert!(
                    x >= bounds[0]
                        && x < bounds[0] + bounds[2]
                        && y >= bounds[1]
                        && y < bounds[1] + bounds[3],
                    "changed pixel ({x},{y}) escaped damage {bounds:?}"
                );
                if let Some(rects) = &damage.rects {
                    assert!(rects.iter().any(|r|x>=r[0]&&x<r[0]+r[2]&&y>=r[1]&&y<r[1]+r[3]),
                        "changed pixel ({x},{y}) escaped the rectangle certificate");
                }
            }
        }
        assert!(changed > 0, "the oracle must cover actual changed pixels");
        changed_right
    }

    #[test]
    fn nested_damage_uses_ancestor_world_transform_and_complex_scenes_revoke_proofs() {
        let mut before = document(json!(["a"]));
        before.nodes.get_mut("a").unwrap().children = vec!["b".into()];
        before.nodes.get_mut("a").unwrap().kind = "frame".into();
        before.nodes.get_mut("a").unwrap().transform = Transform([1.5, 0.25, 0.1, 2., 800., 600.]);
        let mut after = before.clone();
        after.nodes.get_mut("b").unwrap().transform.0[4] += 20.;
        let patch = crate::editing::DocumentPatch {
            nodes: BTreeMap::from([("b".into(), Some(after.nodes["b"].clone()))]),
            fields: BTreeMap::new(),
        };
        let d = patch_damage(&before, &after, &patch);
        assert!(!d.full);
        let bounds = d.bounds.unwrap();
        for doc in [&before, &after] {
            let m = doc.nodes["a"].transform.concat(doc.nodes["b"].transform);
            for p in [
                crate::math::Point::new(0., 0.),
                crate::math::Point::new(40., 40.),
            ] {
                let p = m.point(p);
                assert!(
                    bounds[0] <= p.x
                        && bounds[1] <= p.y
                        && bounds[0] + bounds[2] >= p.x
                        && bounds[1] + bounds[3] >= p.y
                );
            }
        }
        after.nodes.get_mut("b").unwrap().kind = "text".into();
        // Rich leaves (text, vector networks, visible effects) dirty only
        // their own subtree bounds plus bleed; they no longer force full.
        let rich = patch_damage(&before, &after, &patch);
        assert!(!rich.full);
        assert!(rich.bounds.is_some_and(|b| b[2] > 0. && b[3] > 0.));
        after = before.clone();
        after.nodes.get_mut("a").unwrap().mask = true;
        assert!(patch_damage(&before, &after, &patch).full);
    }

    fn document(children: serde_json::Value) -> Document {
        let nodes = json!({
            "a": {"id": "a", "kind": "rectangle", "width": 60., "height": 40.,
                "transform": [1., 0., 0., 1., 24., 24.],
                "fills": [{"kind": "solid", "color": "#4477dd"}]},
            "b": {"id": "b", "kind": "rectangle", "width": 40., "height": 40.,
                "transform": [1., 0., 0., 1., 400., 300.],
                "fills": [{"kind": "solid", "color": "#dd7744"}]}
        });
        serde_json::from_value(json!({
            "schemaVersion": 2, "id": "d", "name": "dirty", "nodes": nodes,
            "pages": [{"id": "p", "name": "p", "children": children, "background": "#ffffff"}],
        }))
        .unwrap()
    }

    fn grid() -> TileGrid {
        TileGrid::new(1., [0., 0.], 4096)
    }

    const VIEWPORT: [f64; 4] = [0., 0., 1920., 1080.];

    #[test]
    fn rename_only_is_clean() {
        let before = document(json!(["a"]));
        let after = before.clone();
        let region = dirty_region(
            &before,
            &after,
            &[Op::SetName {
                id: "a".into(),
                name: "x".into(),
            }],
            &grid(),
            VIEWPORT,
        );
        assert!(!region.full);
        assert!(region.tiles.is_empty());
    }

    #[test]
    fn moving_a_node_dirties_old_and_new_footprints() {
        let before = document(json!(["a", "b"]));
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] = 600.;
        let region = dirty_region(
            &before,
            &after,
            &[Op::SetTransform {
                id: "a".into(),
                matrix: [1., 0., 0., 1., 600., 24.],
            }],
            &grid(),
            VIEWPORT,
        );
        assert!(!region.full);
        // Node a: 60x40 at x=24 -> tile 0; at x=600 -> tile 1 on a 512 grid.
        // The union must cover both the old and the new position.
        let xs: std::collections::BTreeSet<i32> = region.tiles.iter().map(|t| t[0]).collect();
        assert!(xs.contains(&0), "old footprint covered: {xs:?}");
        assert!(xs.contains(&1), "new footprint covered: {xs:?}");
    }

    #[test]
    fn shadow_bleed_expands_the_dirty_bounds() {
        let before = document(json!(["a", "b"]));
        let mut after = before.clone();
        let node = after.nodes.get_mut("a").unwrap();
        node.effects = vec![serde_json::from_value(json!({
            "kind": "shadow", "radius": 30., "x": 12., "y": 8., "color": "#000000", "opacity": 0.5
        }))
        .unwrap()];
        let plain = dirty_region(
            &before,
            &after,
            &[Op::SetOpacity {
                id: "a".into(),
                opacity: 1.,
            }],
            &grid(),
            VIEWPORT,
        );
        // Dirty bounds must exceed the raw 60x40 box by the shadow bleed.
        let bounds = plain.world_bounds.unwrap();
        assert!(bounds[2] > 60. + 30., "bleed included: {bounds:?}");
        assert!(bounds[3] > 40. + 30., "bleed included: {bounds:?}");
    }

    #[test]
    fn child_edit_inside_effect_group_dirties_whole_group() {
        let mut doc = document(json!(["g"]));
        let mut group: Node = serde_json::from_value(json!({
            "id": "g", "kind": "group", "width": 800., "height": 600.,
            "transform": [1., 0., 0., 1., 100., 100.], "children": ["c"],
            "effects": [{"kind": "blur", "radius": 8., "color": "#000000", "opacity": 0.5}]
        }))
        .unwrap();
        group.children = vec!["c".into()];
        doc.nodes.insert(
            "c".into(),
            serde_json::from_value(json!({
                "id": "c", "kind": "rectangle", "width": 30., "height": 30.,
                "transform": [1., 0., 0., 1., 10., 10.],
                "fills": [{"kind": "solid", "color": "#ff0000"}]
            }))
            .unwrap(),
        );
        doc.nodes.insert("g".into(), group);
        let after = doc.clone();
        let region = dirty_region(
            &doc,
            &after,
            &[Op::SetOpacity {
                id: "c".into(),
                opacity: 0.5,
            }],
            &grid(),
            VIEWPORT,
        );
        let bounds = region.world_bounds.unwrap();
        assert!(
            bounds[2] >= 800.,
            "group escalation covers the group footprint: {bounds:?}"
        );
    }

    // Geometry-certificate regressions, deliberately independent of raster
    // execution. Pixel output and the host's retained-tile path need a separate
    // renderer/integration oracle; these tests prove only dirty coverage.
    fn ancestor_effect_document(effects: serde_json::Value) -> Document {
        serde_json::from_value(json!({
            "schemaVersion": 2, "id": "d", "name": "ancestor effects",
            "pages": [{"id": "p", "name": "p", "children": ["g"],
                       "background": "#ffffff"}],
            "nodes": {
                "g": {"id": "g", "kind": "group", "width": 100., "height": 100.,
                      "transform": [1., 0., 0., 1., 0., 0.], "fills": [],
                      "clip": false, "children": ["c"], "effects": effects},
                "c": {"id": "c", "kind": "rectangle", "width": 20., "height": 20.,
                      "transform": [1., 0., 0., 1., 480., 20.], "opacity": 1.,
                      "fills": [{"kind": "solid", "color": "#ff0000"}]}
            }
        }))
        .unwrap()
    }

    fn ancestor_shadow_document() -> Document {
        ancestor_effect_document(json!([{
            "kind": "shadow", "x": 64., "y": 0., "radius": 0.,
            "spread": 0., "opacity": 1., "color": "#000000"
        }]))
    }

    fn ancestor_opacity_change(before: &Document) -> (Document, DirtyRegion) {
        let mut after = before.clone();
        after.nodes.get_mut("c").unwrap().opacity = 0.5;
        let damage = dirty_region(
            before, &after,
            &[Op::SetOpacity { id: "c".into(), opacity: 0.5 }],
            &grid(), [0., 0., 2048., 2048.],
        );
        (after, damage)
    }

    fn assert_ancestor_damage_covers(damage: &DirtyRegion, point: [f64; 2]) {
        assert!(!damage.full, "bounded effect must stay local: {damage:?}");
        let contains = |b: &[f64; 4]| {
            point[0] >= b[0] && point[0] < b[0] + b[2]
                && point[1] >= b[1] && point[1] < b[1] + b[3]
        };
        assert!(contains(&damage.world_bounds.unwrap()), "{point:?}: {damage:?}");
        assert!(damage.world_rects.iter().any(contains),
            "paint-rectangle certificate missed {point:?}: {damage:?}");
    }

    #[test]
    fn ancestor_shadow_on_outside_child_covers_output_and_next_tile() {
        let before = ancestor_shadow_document();
        let (after, damage) = ancestor_opacity_change(&before);
        // Static witness: the child ends at x=500; its zero-radius parent
        // shadow ends at x=564. Baseline ended at x=502 and omitted tile 1.
        assert_ancestor_damage_covers(&damage, [563., 30.]);
        let b = damage.world_bounds.unwrap();
        assert!(b[0] + b[2] >= 564.);
        assert!(damage.tiles.contains(&[1, 0]), "{damage:?}");
        assert!(b[2] < 1024., "do not replace a local proof with canvas-wide damage");
        let patch_damage = patch_damage(&before, &after, &patch(&before, &after));
        assert!(!patch_damage.full);
        let b = patch_damage.bounds.unwrap();
        assert!(b[0] + b[2] >= 564.);
        assert!(patch_damage.rects.unwrap().iter()
            .any(|r| r[0] <= 563. && r[0] + r[2] > 563.
                && r[1] <= 30. && r[1] + r[3] > 30.));
    }

    #[test]
    fn ancestor_effects_compose_in_post_order_through_nested_groups() {
        let mut before = ancestor_shadow_document();
        before.nodes.insert("outer".into(), serde_json::from_value(json!({
            "id": "outer", "kind": "group", "width": 100., "height": 100.,
            "fills": [], "children": ["g"],
            "effects": [{"kind": "shadow", "x": 48., "radius": 0.,
                         "opacity": 1., "color": "#000000"}]
        })).unwrap());
        before.pages[0].children = vec!["outer".into()];
        let (_, damage) = ancestor_opacity_change(&before);
        // The outer shadow includes the inner shadow: 500 + 64 + 48 = 612.
        assert_ancestor_damage_covers(&damage, [611., 30.]);
        let b = damage.world_bounds.unwrap();
        assert!(b[0] + b[2] >= 612.);
        assert!(b[2] < 1024.);
    }

    #[test]
    fn ancestor_blur_support_expands_completed_child_bounds() {
        let before = ancestor_effect_document(json!([{
            "kind": "blur", "radius": 12., "color": "#000000", "opacity": 1.
        }]));
        let (_, damage) = ancestor_opacity_change(&before);
        // Assert the established 2*radius conservative support policy, not
        // a newly invented kernel extent or a claim about changed pixels.
        assert_ancestor_damage_covers(&damage, [523., 30.]);
        let b = damage.world_bounds.unwrap();
        assert!(b[0] + b[2] >= 500. + 2. * 12.);
    }

    #[test]
    fn ancestor_effects_use_composed_world_scale_without_double_transform() {
        let mut before = ancestor_shadow_document();
        before.nodes.get_mut("g").unwrap().transform =
            Transform([0., 2., -3., 0., 1200., 0.]);
        let (_, damage) = ancestor_opacity_change(&before);
        // The rotated anisotropic parent maps the shadow offset to (0,128).
        // Its child plus shadow reaches y=1128; max_scale=3 is conservative.
        assert_ancestor_damage_covers(&damage, [1110., 1127.]);
        let b = damage.world_bounds.unwrap();
        assert!(b[1] + b[3] >= 1128.);
        assert!(b[1] + b[3] <= 1200., "world coordinates applied twice: {b:?}");
        assert!(damage.tiles.contains(&[2, 2]));
    }

    #[test]
    fn ancestor_effects_keep_conservative_clip_semantics() {
        let mut before = ancestor_shadow_document();
        before.nodes.get_mut("g").unwrap().kind = "frame".into();
        before.nodes.get_mut("g").unwrap().clip = true;
        before.nodes.get_mut("c").unwrap().transform.0[4] = 90.;
        let (_, damage) = ancestor_opacity_change(&before);
        // Clip consumes child content before the parent's shadow, so the
        // shadow of visible content can still extend beyond the clip edge.
        assert_ancestor_damage_covers(&damage, [163., 30.]);
        // Bounds deliberately retain the pre-existing conservative policy
        // of not cropping to logical clip boxes, including fully outside
        // children. This is allowed overinvalidation, not a clip precision test.
        before.nodes.get_mut("c").unwrap().transform.0[4] = 480.;
        let (_, outside) = ancestor_opacity_change(&before);
        assert_ancestor_damage_covers(&outside, [563., 30.]);
        assert!(outside.world_bounds.unwrap()[2] < 1024.);
    }

    #[test]
    fn ancestor_effect_free_groups_do_not_accumulate_stroke_or_aa_padding() {
        let mut before = ancestor_effect_document(json!([]));
        for i in 0..4 {
            let id = format!("outer-{i}");
            let child = before.pages[0].children[0].clone();
            before.nodes.insert(id.clone(), serde_json::from_value(json!({
                "id": id, "kind": "group", "width": 100., "height": 100.,
                "fills": [], "children": [child],
                "strokes": [{"width": 2., "visible": true,
                             "paint": {"kind": "solid", "color": "#000000"}}]
            })).unwrap());
            before.pages[0].children = vec![id];
        }
        let (_, damage) = ancestor_opacity_change(&before);
        assert_eq!(damage.world_bounds, Some([478., 18., 24., 24.]));
        assert!(!damage.tiles.contains(&[1, 0]));
        let parents = parent_map(&before);
        let b = subtree_bounds(&before, &parents, "outer-3", None).unwrap();
        assert_eq!(b, [-10., -10., 502., 110.]);
    }

    #[test]
    fn ancestor_effect_leaf_preserves_original_margin_arithmetic() {
        for (x, y, offset, width) in [
            (0.1, 0.3, 0.1, 0.2),
            (1e12 + 0.125, -1e12 + 0.25, 0.7, 0.3),
            (-1e12 + 0.125, 1e12 + 0.25, 0.1, 0.2),
        ] {
            let mut doc = ancestor_shadow_document();
            let node = doc.nodes.get_mut("g").unwrap();
            node.children.clear();
            node.transform = Transform([1., 0., 0., 1., x, y]);
            node.effects[0].x = offset;
            node.strokes = vec![serde_json::from_value(json!({
                "width": width, "visible": true,
                "paint": {"kind": "solid", "color": "#000000"}
            })).unwrap()];
            // Explicit original arithmetic for this identity-scale, 100x100
            // logical group, whose own path is empty. Do not call the new
            // margin helpers to calculate the reference under test.
            let halo = offset;
            let strokes = width * 4.;
            let margin = (halo + strokes) + 2.;
            let expected = [
                x - margin, y - margin,
                (100. + x) + margin, (100. + y) + margin,
            ];
            let actual = subtree_bounds(&doc, &parent_map(&doc), "g", None).unwrap();
            assert_eq!(actual.map(f64::to_bits), expected.map(f64::to_bits),
                "leaf arithmetic changed for x={x}, y={y}, offset={offset}, width={width}");
        }
    }

    #[test]
    fn ancestor_effect_move_keeps_old_and_new_shadow_footprints() {
        let before = ancestor_shadow_document();
        let mut after = before.clone();
        after.nodes.get_mut("c").unwrap().transform.0[4] = 960.;
        let damage = dirty_region(
            &before, &after,
            &[Op::SetTransform { id: "c".into(), matrix: after.nodes["c"].transform.0 }],
            &grid(), [0., 0., 2048., 2048.],
        );
        assert_ancestor_damage_covers(&damage, [563., 30.]);
        assert_ancestor_damage_covers(&damage, [1043., 30.]);
        assert!(damage.tiles.contains(&[2, 0]));
    }

    #[test]
    fn ancestor_effect_delete_keeps_prior_shadow_footprint() {
        let before = ancestor_shadow_document();
        let mut after = before.clone();
        after.nodes.remove("c");
        after.nodes.get_mut("g").unwrap().children.clear();
        let damage = dirty_region(
            &before, &after, &[Op::RemoveNode { id: "c".into() }],
            &grid(), VIEWPORT,
        );
        assert_ancestor_damage_covers(&damage, [563., 30.]);
        assert!(damage.tiles.contains(&[1, 0]));
    }

    #[test]
    fn ancestor_effect_hide_keeps_prior_shadow_footprint() {
        let before = ancestor_shadow_document();
        let mut after = before.clone();
        after.nodes.get_mut("c").unwrap().visible = false;
        let damage = dirty_region(
            &before, &after, &[Op::SetVisible { id: "c".into(), visible: false }],
            &grid(), VIEWPORT,
        );
        assert_ancestor_damage_covers(&damage, [563., 30.]);
        assert!(damage.tiles.contains(&[1, 0]));
    }

    #[test]
    fn ancestor_effect_nonfinite_support_fails_closed() {
        for invalid in [f64::NAN, f64::INFINITY, 1e308] {
            let before = ancestor_shadow_document();
            let mut after = before.clone();
            // 1e308 has finite extrema but an overflowing expanded extent.
            after.nodes.get_mut("g").unwrap().effects[0].x = invalid;
            let damage = dirty_region(
                &before, &after, &[Op::SetOpacity { id: "c".into(), opacity: 0.5 }],
                &grid(), VIEWPORT,
            );
            assert!(damage.full, "invalid support {invalid}: {damage:?}");
            assert_eq!(damage.reason, Some("non-finite geometry in updated revision"));
        }
        let before = ancestor_shadow_document();
        let mut after = before.clone();
        after.nodes.get_mut("g").unwrap().transform.0[0] = 1e308;
        let damage = dirty_region(
            &before, &after, &[Op::SetOpacity { id: "c".into(), opacity: 0.5 }],
            &grid(), VIEWPORT,
        );
        assert!(damage.full, "finite matrix can overflow composed corners/scale");
    }

    #[test]
    fn insert_reports_new_footprint_and_removal_reports_old() {
        let before = document(json!(["a"]));
        let mut after = before.clone();
        after.nodes.insert(
            "new".into(),
            serde_json::from_value(json!({
                "id": "new", "kind": "rectangle", "width": 30., "height": 30.,
                "transform": [1., 0., 0., 1., 1500., 200.],
                "fills": [{"kind": "solid", "color": "#00ff00"}]
            }))
            .unwrap(),
        );
        after.pages[0].children.push("new".into());
        let inserted = dirty_region(
            &before,
            &after,
            &[Op::InsertNode {
                parent: "p".into(),
                index: 1,
                node: serde_json::from_value(json!({
                    "id": "new", "kind": "rectangle", "width": 30., "height": 30.,
                    "transform": [1., 0., 0., 1., 1500., 200.],
                    "fills": [{"kind": "solid", "color": "#00ff00"}]
                }))
                .unwrap(),
            }],
            &grid(),
            VIEWPORT,
        );
        assert!(!inserted.full);
        assert!(
            inserted.tiles.iter().any(|t| t[0] >= 2),
            "{:?} {:?}",
            inserted.tiles,
            inserted.world_bounds
        );

        let removed = dirty_region(
            &after,
            &before,
            &[Op::RemoveNode { id: "new".into() }],
            &grid(),
            VIEWPORT,
        );
        assert!(!removed.full);
        assert!(removed.tiles.iter().any(|t| t[0] >= 2));
    }

    #[test]
    fn unknown_target_degrades_to_full() {
        let before = document(json!(["a"]));
        let after = before.clone();
        let region = dirty_region(
            &before,
            &after,
            &[Op::SetVisible {
                id: "ghost".into(),
                visible: false,
            }],
            &grid(),
            VIEWPORT,
        );
        assert!(region.full);
        assert_eq!(region.reason, Some("op target missing from both revisions"));
    }

    #[test]
    fn offscreen_changes_report_no_tiles() {
        let mut before = document(json!(["a", "b"]));
        before.nodes.get_mut("a").unwrap().transform.0[4] = 100000.;
        let after = before.clone();
        let region = dirty_region(
            &before,
            &after,
            &[Op::SetOpacity {
                id: "a".into(),
                opacity: 0.5,
            }],
            &grid(),
            VIEWPORT,
        );
        assert!(!region.full);
        assert!(
            region.tiles.is_empty(),
            "viewport clip removed the offscreen change"
        );
    }

    #[test]
    fn deterministic_output() {
        let before = document(json!(["a", "b"]));
        let after = before.clone();
        let op = Op::SetOpacity {
            id: "b".into(),
            opacity: 0.5,
        };
        let first = dirty_region(&before, &after, &[op.clone()], &grid(), VIEWPORT);
        let second = dirty_region(&before, &after, &[op], &grid(), VIEWPORT);
        assert_eq!(first, second);
    }

    #[test]
    fn tile_budget_degrades_to_full() {
        let before = document(json!(["a", "b"]));
        let mut after = before.clone();
        after.nodes.get_mut("a").unwrap().transform.0[4] = 90000.;
        let region = dirty_region(
            &before,
            &after,
            &[Op::SetTransform {
                id: "a".into(),
                matrix: [1., 0., 0., 1., 90000., 24.],
            }],
            &TileGrid::new(1., [0., 0.], 1),
            [0., 0., 100000., 100000.],
        );
        assert!(region.full);
        assert_eq!(region.reason, Some("visible tile budget exceeded"));
    }

    #[test]
    fn rigid_leaf_rotation_is_local_and_a_backdrop_reader_stays_unbounded() {
        let doc = document(json!(["a", "b"]));
        let parents = crate::render_index::Parents::new(&doc);
        let fonts = Fonts::new();
        let mut turned = BTreeMap::new();
        turned.insert("a".into(), Transform([0., 1., -1., 0., 24., 24.]));
        let damage = resolved_leaf_pose_damage(&doc, &parents, &turned, &fonts).expect("plain leaf rotation");
        assert!(!damage.full);
        let bounds = damage.bounds.expect("union");
        assert!(bounds[0] <= -16. && bounds[1] <= 24. && bounds[0] + bounds[2] >= 84. && bounds[1] + bounds[3] >= 84.);
        assert!(damage.rects.is_some_and(|rects| rects.len() == 2));
        let mut backdrop = doc.clone();
        backdrop.nodes.get_mut("b").unwrap().effects.push(serde_json::from_value(json!({"kind":"background-blur","radius":4.,"color":"#000000","visible":true})).unwrap());
        let parents = crate::render_index::Parents::new(&backdrop);
        assert!(resolved_leaf_pose_damage(&backdrop, &parents, &turned, &fonts).is_none());
    }

    #[test]
    fn grouped_leaf_rotation_stays_local_until_the_container_filters() {
        let doc = serde_json::from_value(json!({
            "schemaVersion": 2, "id": "d", "name": "dirty",
            "pages": [{"id": "p", "name": "p", "children": ["g", "far"], "background": "#ffffff"}],
            "nodes": {
                "g": {"id": "g", "kind": "group", "width": 80., "height": 60.,
                    "transform": [1., 0., 0., 1., 24., 24.], "children": ["c"], "fills": []},
                "c": {"id": "c", "kind": "rectangle", "width": 20., "height": 16.,
                    "transform": [1., 0., 0., 1., 10., 10.],
                    "fills": [{"kind": "solid", "color": "#4477dd"}]},
                "far": {"id": "far", "kind": "rectangle", "width": 10., "height": 10.,
                    "transform": [1., 0., 0., 1., 400., 300.],
                    "fills": [{"kind": "solid", "color": "#112233"}]}
            }
        })).unwrap();
        let parents = crate::render_index::Parents::new(&doc);
        let fonts = Fonts::new();
        let mut turned = BTreeMap::new();
        turned.insert("g".into(), Transform([0., -1., 1., 0., 24., 24.]));
        let damage = resolved_leaf_pose_damage(&doc, &parents, &turned, &fonts).expect("plain group rotation");
        assert!(!damage.full);
        let bounds = damage.bounds.expect("union");
        let covers = |x: f64, y: f64| bounds[0] <= x && bounds[1] <= y && bounds[0] + bounds[2] >= x && bounds[1] + bounds[3] >= y;
        assert!(covers(34., 34.), "old child missed {bounds:?}");
        assert!(covers(40., 0.), "rotated child missed {bounds:?}");
        assert!(!covers(400., 300.), "far sibling entered {bounds:?}");
        assert!(damage.rects.is_some_and(|rects| rects.len() == 2));
        let mut filtered = doc.clone();
        filtered.nodes.get_mut("g").unwrap().effects.push(serde_json::from_value(json!({
            "kind": "blur", "radius": 4., "color": "#000000", "visible": true
        })).unwrap());
        let parents = crate::render_index::Parents::new(&filtered);
        assert!(resolved_leaf_pose_damage(&filtered, &parents, &turned, &fonts).is_none());
    }
}


#[cfg(test)]
mod parent_map_reuse_tests {
    use super::*;
    use serde_json::json;

    fn source() -> Document {
        serde_json::from_value(json!({
            "schemaVersion": 2, "id": "map-reuse", "name": "map-reuse",
            "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": ["frame", "blur"]}],
            "nodes": {
                "frame": {"id": "frame", "kind": "frame", "width": 80, "height": 60,
                    "children": ["leaf"], "effects": [{"kind": "blur", "radius": 4, "visible": true, "color": "#000000"}]},
                "leaf": {"id": "leaf", "kind": "rectangle", "width": 16, "height": 20,
                    "transform": [1, 0, 0, 1, 10, 10], "fills": [{"kind": "solid", "color": "#cc3366"}]},
                "blur": {"id": "blur", "kind": "frame", "width": 48, "height": 48,
                    "transform": [1, 0, 0, 1, 20, 0],
                    "effects": [{"kind": "background-blur", "radius": 6, "visible": true, "color": "#000000"}]}
            }
        })).unwrap()
    }

    fn constructions() -> usize { PARENT_MAP_CONSTRUCTIONS.with(|count| count.get()) }
    fn reset_constructions() { PARENT_MAP_CONSTRUCTIONS.with(|count| count.set(0)); }

    #[test]
    fn bounded_patch_builds_only_its_existing_parent_map_pair() {
        let before = source();
        before.validate().unwrap();
        let mut after = before.clone();
        after.nodes.get_mut("leaf").unwrap().transform.0[4] = 14.375;
        let patch = crate::editing::DocumentPatch::between(&before, &after).unwrap();
        reset_constructions();
        let damage = patch_damage(&before, &after, &patch);
        assert!(!damage.full, "this case must reach bounded background-read propagation");
        assert_eq!(constructions(), 2, "parent_index has distinct semantics and is not counted");
    }

    #[test]
    fn supplied_maps_match_owned_maps_for_background_closure_and_empty_damage() {
        let before = source();
        let mut after = before.clone();
        after.nodes.get_mut("leaf").unwrap().transform.0[4] = 14.375;
        let ops = [Op::SetTransform { id: "leaf".into(), matrix: after.nodes["leaf"].transform.0 }];
        let before_parents = parent_map(&before);
        let after_parents = parent_map(&after);
        for rects in [vec![[10., 10., 20., 24.]], Vec::new()] {
            let mut owned = full();
            for rect in rects {
                let bounds = [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]];
                add_paint_rect(&mut owned, bounds);
                union_box(owned.world_bounds.as_mut().unwrap(), bounds);
            }
            let mut supplied = owned.clone();
            let owned_result = propagate_background_reads(&before, &after, &mut owned, None, &ops,
                &mut Default::default(), None, None);
            reset_constructions();
            let supplied_result = propagate_background_reads(&before, &after, &mut supplied, None, &ops,
                &mut Default::default(), Some([&before_parents, &after_parents]), None);
            assert_eq!(supplied_result, owned_result);
            assert_eq!(supplied, owned, "same arithmetic, activation order and output damage");
            assert_eq!(constructions(), 0, "borrowed exact maps are not reconstructed");
        }
    }

    #[test]
    fn standalone_clipped_translation_keeps_its_owned_maps() {
        let document = source();
        let fonts = Fonts::new();
        reset_constructions();
        let damage = clipped_translation_damage(&document, vec![[0., 0., 30., 30.]],
            vec!["frame".into()], &fonts);
        assert!(!damage.full);
        assert_eq!(constructions(), 2, "the standalone entry has no supplied maps");
    }

    #[test]
    fn page_parent_sentinels_are_not_replaced_by_parent_index() {
        let document = source();
        let map = parent_map(&document);
        let index = parent_index(&document);
        assert_eq!(map.get("frame"), Some(&"p"));
        assert_eq!(index.get("frame"), None);
        assert_eq!(map.get("leaf"), Some(&"frame"));
        assert_eq!(index.get("leaf"), Some(&"frame"));
    }
}

#[cfg(test)] mod page_control_tests {
    use super::*;
    use serde_json::json;
    fn document()->Document {serde_json::from_value(json!({"schemaVersion":20,"id":"d","name":"page-proof","pages":[{"id":"p","name":"p","children":["group"],"background":"#fff"}],"nodes":{
        "group":{"id":"group","kind":"group","width":1,"height":1,"transform":[1.25,0.125,-0.375,0.75,1000.125,-928.375],"children":["curve"],"effects":[{"kind":"shadow","radius":3.75,"x":-2.25,"color":"#000000"}]},
        "curve":{"id":"curve","kind":"vector","width":10,"height":10,"transform":[0.5,-0.2,0.125,1.3,-1000.125,928.375],"vectorGeometry":{"fillRule":"nonzero","fill":[{"move":[-20,1]},{"cubic":[-100,30,280,-140,110,80]},{"line":[4,170]},"close"]},"strokes":[{"width":3.25,"paint":{"kind":"solid","color":"#000000"}}],"effects":[{"kind":"gaussian-blur","radius":1.125,"color":"#000000"}]}
    }})).unwrap()}
    #[test] fn page_controls_enclose_original_geometry_with_affine_effects_and_fallbacks(){
        for offset in [0.,2.] {
            let mut d=document();d.nodes.get_mut("curve").unwrap().path_offset=offset;
            for scale in [0.001,0.125,1.,1.25,19.,64.,128.] {
                let camera=Transform([scale,0.,0.,scale,0.25,-0.375]);let fonts=Fonts::new();
                let old=subtree_bounds_from(&d,"group",camera,Some(&fonts),true).unwrap();
                let new=page_paint_rects(&d,"p",&fonts,camera).unwrap()[0];
                assert!(new[0]<=old[0]&&new[1]<=old[1]&&new[2]>=old[2]&&new[3]>=old[3],"offset={offset}, scale={scale}: {new:?} vs {old:?}");
                if offset!=0. {assert_eq!(new,old)}
            }
        }
    }
    #[test] fn covered_output_declines_only_useless_background_sampling(){
        let mut d=document();let root=d.nodes.get_mut("group").unwrap();root.width=1000.;root.height=1000.;root.transform=Transform::default();
        for scale in [0.125,1.,19.,64.] {for shift in [[0.,0.],[17.25,-9.375]] {
            let camera=Transform([scale,0.,0.,scale,0.,0.]);
            let output=crate::math::Rect::new(32,32,32,32);
            assert!(!page_background_can_sample(&d,"p",camera,shift,output));
            let full=page_paint_rects(&d,"p",&Fonts::new(),camera).unwrap()[0];
            assert!(full[0]+shift[0]<=32.&&full[1]+shift[1]<=32.&&full[2]+shift[0]>=64.&&full[3]+shift[1]>=64.);
            assert!(page_background_can_sample(&d,"p",camera,shift,crate::math::Rect::new(1000000,0,64,64)));
        }}
    }
    #[test] fn empty_stage_keeps_disjoint_paint_and_real_white_shapes_remain_paint(){
        let mut d:Document=serde_json::from_value(json!({"schemaVersion":20,"id":"s","name":"s","pages":[{"id":"p","name":"p","children":["stage"],"background":"#ffffff"}],"nodes":{
            "stage":{"id":"stage","kind":"frame","width":10000,"height":10000,"blend":"pass-through","children":["a","b"],"transform":[1.25,0.25,-0.125,0.75,10.125,-8.5]},
            "a":{"id":"a","kind":"rectangle","width":100,"height":100,"fills":[{"kind":"solid","color":"#ffffff"}]},
            "b":{"id":"b","kind":"rectangle","width":100,"height":100,"transform":[1,0,0,1,4000,4000],"fills":[{"kind":"solid","color":"#abcdef"}]}
        }})).unwrap();
        let fonts=Fonts::new();let camera=Transform([2.,0.,0.,2.,0.125,0.375]);
        let sparse=page_paint_rects(&d,"p",&fonts,camera).unwrap();assert_eq!(sparse.len(),2);
        let matrix=camera.concat(d.nodes["stage"].transform);
        let outward=|bounds:[f64;4]|[bounds[0].floor(),bounds[1].floor(),bounds[2].ceil(),bounds[3].ceil()];
        assert_eq!(sparse[0],outward(subtree_bounds_from(&d,"a",matrix,Some(&fonts),true).unwrap()));
        assert_eq!(sparse[1],outward(subtree_bounds_from(&d,"b",matrix,Some(&fonts),true).unwrap()));
        assert!(page_background_can_sample(&d,"p",camera,[0.,0.],crate::math::Rect::new(500,500,64,64)));
        // A white rectangle is paint even on a white page: it may occlude a
        // preceding object. Only an empty container's selection box disappears.
        d.nodes.get_mut("stage").unwrap().fills=d.nodes["a"].fills.clone();
        assert_eq!(page_paint_rects(&d,"p",&fonts,camera).unwrap().len(),1);
        d.nodes.get_mut("stage").unwrap().fills.clear();d.nodes.get_mut("stage").unwrap().clip=true;
        assert_eq!(page_paint_rects(&d,"p",&fonts,camera).unwrap().len(),1);
    }
    #[test] fn cancelled_page_proof_stops_before_curve_expansion(){
        let d=document();let fonts=Fonts::new();
        let stopped=crate::render_cancellation::with_probe(||true,||page_paint_rects(&d,"p",&fonts,Transform::default()));
        assert!(stopped.is_none());assert!(page_paint_rects(&d,"p",&fonts,Transform::default()).is_some());
    }
}
