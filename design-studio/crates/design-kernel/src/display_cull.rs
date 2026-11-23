//! Reject plain primitives before per-node geometry preparation.
//!
//! The predicate is the existing early leaf proof: a width/height box with no
//! effects, strokes, children, or generated paths, expanded by the same two
//! device pixels. Nodes that fail the proof are prepared exactly as before.
use crate::geometry_support::axis_box;
use crate::math::{Rect, Transform};
use crate::scene::{Document, Node};

#[derive(Clone, Copy)]
pub(crate) struct PlainBox {
    transform: Transform,
    width: f64,
    height: f64,
}

pub(crate) fn classify(doc: &Document, children: &[String]) -> Vec<Option<PlainBox>> {
    children
        .iter()
        .map(|id| doc.nodes.get(id).and_then(plain_box))
        .collect()
}

fn plain_box(node: &Node) -> Option<PlainBox> {
    // Generated geometry, effects and strokes can extend past the local box
    // or change the early-reject padding. Leave those on the ordinary walk.
    if !node.children.is_empty()
        || node.vector_brush.is_some()
        || node.path_offset != 0.
        || node.derived_path.is_some()
        || node.network.is_some()
        || node.vector_geometry.is_some()
        || node.arc.is_some()
        || node.effects.iter().any(|effect| effect.visible)
        || node.strokes.iter().any(|stroke| stroke.visible)
        || !matches!(
            node.kind.as_str(),
            "slice" | "frame" | "section" | "rectangle" | "ellipse" | "line"
        )
        || !node.width.is_finite()
        || !node.height.is_finite()
        || node.width < 0.
        || node.height < 0.
    {
        return None;
    }
    Some(PlainBox {
        transform: node.transform,
        width: node.width,
        height: node.height,
    })
}

/// `true` only when the ordinary early reject would also discard this leaf.
pub(crate) fn outside_guard(plain: &PlainBox, parent: Transform, guard: Rect) -> bool {
    let Some(bounds) = axis_box(parent.concat(plain.transform), plain.width, plain.height) else {
        return false;
    };
    bounds.expand(2).intersect(guard).empty()
}
