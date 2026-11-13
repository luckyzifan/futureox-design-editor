//! Proven field-to-derived-product edges. Unknown fields take the full resolve
//! path; a new schema field cannot accidentally enter this allow-list.
use crate::scene::{Effect, Node};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum PaintChange { Material, Parameter, Bounds }

pub(crate) struct RetainedPaint {
    pub bounds: Vec<String>,
    pub parameter_only: bool,
}

/// Gradient endpoints and a zoom-blur focal point do not change path geometry,
/// blur radius, or effect support. Counts, amount, and every other field stay
/// on the existing bounds path.
fn blur_axis_edit(before: &Effect, after: &Effect) -> bool {
    if before == after { return true; }
    let mut adjusted = before.clone();
    if let (Some(from), Some(to)) = (adjusted.gradient_blur.as_mut(), after.gradient_blur.as_ref()) {
        // Layer blur only. Background-blur progressive mode is a separate issue.
        if after.kind != "blur" { return false; }
        if from.start_count.to_bits() != to.start_count.to_bits()
            || from.end_count.to_bits() != to.end_count.to_bits()
            || from.smooth != to.smooth
        {
            return false;
        }
        if to.start.iter().chain(to.end.iter()).any(|value| !value.is_finite() || value.abs() > 1e7) { return false; }
        from.start = to.start;
        from.end = to.end;
        return adjusted == *after;
    }
    if let (Some(from), Some(to)) = (adjusted.zoom_blur.as_mut(), after.zoom_blur.as_ref()) {
        if after.kind != "zoom-blur" || from.amount.to_bits() != to.amount.to_bits() { return false; }
        if to.center.iter().any(|value| !value.is_finite() || value.abs() > 1e6) { return false; }
        from.center = to.center;
        return adjusted == *after;
    }
    false
}

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
    if old.effects == next.effects { return Some(PaintChange::Material); }
    let axes = old.fills == next.fills && old.opacity.to_bits() == next.opacity.to_bits() && old.strokes == next.strokes
        && old.effects.len() == next.effects.len()
        && old.effects.iter().zip(&next.effects).all(|(before, after)| blur_axis_edit(before, after))
        && old.effects.iter().zip(&next.effects).any(|(before, after)| before != after);
    Some(if axes { PaintChange::Parameter } else { PaintChange::Bounds })
}

pub(crate) fn apply_paint(target: &mut Node, next: &Node) {
    target.fills = next.fills.clone(); target.opacity = next.opacity;
    target.effects = next.effects.clone();
    for (stroke, new) in target.strokes.iter_mut().zip(&next.strokes) { stroke.paint = new.paint.clone(); }
}
