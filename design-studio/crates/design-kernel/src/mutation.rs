//! Shared dependent-field semantics for authored and resolved node mutations.
use crate::{font::TextRun, scene::Node};
use std::collections::BTreeSet;
use unicode_segmentation::UnicodeSegmentation;

/// Resize geometry using the old dimensions before publishing the new box.
/// Callers enforce their own sizing constraints (layout clamps; bindings validate).
pub(crate) fn resize(n: &mut Node, width: f64, height: f64) {
    if let Some(g) = &mut n.network {
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
