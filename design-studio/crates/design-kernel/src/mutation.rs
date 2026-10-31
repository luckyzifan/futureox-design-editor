//! Shared dependent-field semantics for authored and resolved node mutations.
use crate::{font::TextRun, scene::Node};
use std::collections::BTreeSet;
use unicode_segmentation::UnicodeSegmentation;

/// Resize geometry using the old dimensions before publishing the new box.
/// Callers enforce their own sizing constraints (layout clamps; bindings validate).
pub(crate) fn resize(n: &mut Node, width: f64, height: f64) {
    // Layout replays the current box before solving constraints. Do not detach
    // shared geometry or touch every control point for that identity operation.
    // Degenerate/nonfinite dimensions retain the original arithmetic/rejection
    // path, and a signed-zero change still publishes the requested bits.
    if width.is_finite() && height.is_finite() && width > 0. && height > 0. &&
        width.to_bits() == n.width.to_bits() && height.to_bits() == n.height.to_bits() { return; }
    if let Some(geometry)=&mut n.vector_geometry {std::sync::Arc::make_mut(geometry).scale(width/n.width,height/n.height);}
    if let Some(g) = &mut n.network {
        let g = std::sync::Arc::make_mut(g);
        let sx = width / n.width;
        let sy = height / n.height;
        for p in &mut g.vertices {
            p.x *= sx;
            p.y *= sy;
        }
        for e in &mut g.edges {
            for p in [&mut e.c1, &mut e.c2].into_iter().flatten() {
                p.x *= sx;
                p.y *= sy;
            }
        }
    }
    n.width = width;
    n.height = height;
}

#[cfg(test)]
mod resize_reuse_tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn unchanged_positive_box_keeps_shared_geometry_and_real_resize_detaches() {
        let mut node=crate::facet::sample_node("n","vector");node.width=10.;node.height=20.;
        let geometry:Arc<crate::vector_geometry::VectorGeometry>=Arc::new(serde_json::from_str(r#"{"fillRule":"nonzero","fill":[{"move":[-0.0,1.25]},{"line":[10,20]}]}"#).unwrap());
        node.vector_geometry=Some(geometry.clone());let before=serde_json::to_vec(&node).unwrap();
        for _ in 0..68 {resize(&mut node,10.,20.);}
        assert!(Arc::ptr_eq(node.vector_geometry.as_ref().unwrap(),&geometry));
        assert_eq!(serde_json::to_vec(&node).unwrap(),before);
        resize(&mut node,20.,60.);
        assert!(!Arc::ptr_eq(node.vector_geometry.as_ref().unwrap(),&geometry));
        assert_eq!(geometry.fill[1],crate::vector_geometry::Curve::Line([10.,20.]));
        assert_eq!(node.vector_geometry.as_ref().unwrap().fill[1],crate::vector_geometry::Curve::Line([20.,60.]));
    }
    #[test]
    fn degenerate_and_signed_zero_boxes_keep_original_arithmetic() {
        let mut node=crate::facet::sample_node("n","rectangle");node.width=-0.;node.height=1.;
        resize(&mut node,0.,1.);assert_eq!(node.width.to_bits(),0_f64.to_bits());
        let geometry=Arc::new(serde_json::from_str(r#"{"fillRule":"nonzero","fill":[{"move":[1,2]}]}"#).unwrap());
        node.vector_geometry=Some(geometry);resize(&mut node,0.,1.);
        if let crate::vector_geometry::Curve::Move(p)=node.vector_geometry.as_ref().unwrap().fill[0] {assert!(p[0].is_nan());}else{panic!("original move")}
    }
}
fn boundaries(text: &str) -> BTreeSet<usize> {
    let mut result = BTreeSet::from([0]);
    let mut at = 0;
    for g in text.graphemes(true) {
        at += g.encode_utf16().count();
        result.insert(at);
    }
    result
}
/// Preserve common prefix/suffix styles; inserted text inherits the style at
/// the replacement start. All offsets are UTF-16 and cuts are whole graphemes,
/// matching the editor's text replacement contract.
pub(crate) fn replace_text(n: &mut Node, text: String) {
    if n.text == text {
        return;
    }
    let old: Vec<_> = n.text.encode_utf16().collect();
    let next: Vec<_> = text.encode_utf16().collect();
    let old_bounds = boundaries(&n.text);
    let next_bounds = boundaries(&text);
    let mut start = old.iter().zip(&next).take_while(|(a, b)| a == b).count();
    while start > 0 && (!old_bounds.contains(&start) || !next_bounds.contains(&start)) {
        start -= 1;
    }
    let (mut end, mut next_end) = (old.len(), next.len());
    while end > start && next_end > start && old[end - 1] == next[next_end - 1] {
        end -= 1;
        next_end -= 1;
    }
    while end < old.len() && (!old_bounds.contains(&end) || !next_bounds.contains(&next_end)) {
        end += 1;
        next_end += 1;
    }
    let inherited = n
        .text_runs
        .iter()
        .find(|r| r.start <= start && start <= r.end)
        .cloned();
    let mut runs: Vec<TextRun> = Vec::new();
    for run in &n.text_runs {
        if run.start < start {
            let mut r = run.clone();
            r.end = r.end.min(start);
            runs.push(r);
        }
        if run.end > end {
            let mut r = run.clone();
            r.start = r.start.max(end) - end + next_end;
            r.end = r.end - end + next_end;
            runs.push(r);
        }
    }
    if let Some(mut r) = inherited.filter(|_| next_end > start) {
        r.start = start;
        r.end = next_end;
        runs.push(r);
    }
    runs.sort_by_key(|r| r.start);
    runs.retain(|r| r.start < r.end);
    n.text = text;
    n.text_runs = runs;
}
/// Apply dependent-field semantics after generic field deserialization, unless
/// the caller explicitly supplied the dependent geometry/ranges themselves.
pub(crate) fn reconcile(old: &Node, next: &mut Node, network_explicit: bool, runs_explicit: bool) {
    if !network_explicit && (next.width != old.width || next.height != old.height) {
        let (w, h) = (next.width, next.height);
        next.width = old.width;
        next.height = old.height;
        resize(next, w, h);
    }
    if !runs_explicit && next.text != old.text {
        let text = std::mem::replace(&mut next.text, old.text.clone());
        replace_text(next, text);
    }
}

/// Live Boolean geometry is rebuilt from operands, so resize those operands
/// too. Left-scaling their transforms preserves curves and nested groups.
pub(crate) fn resize_boolean_children(
    nodes: &mut std::collections::BTreeMap<String, Node>,
    children: &[String],
    sx: f64,
    sy: f64,
) {
    if sx == 1. && sy == 1. {
        return;
    }
    let scale = crate::math::Transform([sx, 0., 0., sy, 0., 0.]);
    for id in children {
        if let Some(child) = nodes.get_mut(id) {
            child.transform = scale.concat(child.transform);
        }
    }
}
