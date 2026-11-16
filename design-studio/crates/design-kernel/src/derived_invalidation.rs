//! Proven field-to-derived-product edges. Unknown fields take the full resolve
//! path; a new schema field cannot accidentally enter this allow-list.
use crate::scene::Node;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum PaintChange { Material, ZoomFocus, Bounds }

pub(crate) fn paint_change(old: &Node, next: &Node) -> Option<PaintChange> {
    // Rich text paint is expanded into generated children; keep its resolver
    // until those generated dependencies are tracked explicitly.
    if old.kind == "text" || !old.text_runs.is_empty() { return None; }
    let mut candidate = old.clone();
    candidate.fills = next.fills.clone();
    candidate.opacity = next.opacity;
    candidate.effects = next.effects.clone();
    // Stroke paint does not alter the outline. Width/alignment/dashes do.
    if candidate.strokes.len() != next.strokes.len() { return None; }
    for (stroke, new) in candidate.strokes.iter_mut().zip(&next.strokes) {
        stroke.paint = new.paint.clone();
    }
    if candidate != *next { return None; }
    if old.effects == next.effects {
        return Some(PaintChange::Material);
    }
    // Moving only the center changes radial sample coordinates, not the
    // authored outset, geometry, active-effect flags or backdrop predicates.
    // The compiler still replans each tile for the new sampling center.
    if old.fills == next.fills && old.opacity == next.opacity && old.strokes == next.strokes
        && old.effects.len() == next.effects.len()
        && old.effects.iter().zip(&next.effects).all(|(before, after)| {
            if before == after { return true; }
            let (Some(mut blur), Some(new_blur)) = (before.zoom_blur, after.zoom_blur) else { return false; };
            blur.center = new_blur.center;
            let mut equivalent = before.clone();
            equivalent.zoom_blur = Some(blur);
            equivalent == *after
        })
    {
        return Some(PaintChange::ZoomFocus);
    }
    Some(PaintChange::Bounds)
}

pub(crate) fn apply_paint(target: &mut Node, next: &Node) {
    target.fills = next.fills.clone(); target.opacity = next.opacity;
    target.effects = next.effects.clone();
    for (stroke, new) in target.strokes.iter_mut().zip(&next.strokes) { stroke.paint = new.paint.clone(); }
}
