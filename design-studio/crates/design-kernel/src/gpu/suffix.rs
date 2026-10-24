//! Conservative reverse consumption for parent color targets only. Sources
//! keep their original rectangles and all sampling/rounding stages. An own
//! backdrop or pass-through node retains the entire original parent prefix.
use super::GpuNode;
use crate::math::Rect;
use std::collections::BTreeMap;

fn bounded(r: Rect) -> bool {
    !r.empty() && [r.x, r.y, r.right(), r.bottom()].iter().all(|v| i64::from(*v).abs() <= 1_048_576)
}
fn rounded(r: Rect, domain: Rect) -> Rect {
    let x = r.x.div_euclid(64) * 64;
    let y = r.y.div_euclid(64) * 64;
    let right = (r.right() + 63).div_euclid(64) * 64;
    let bottom = (r.bottom() + 63).div_euclid(64) * 64;
    Rect::new(x, y, (right - x) as u32, (bottom - y) as u32).intersect(domain)
}
pub(super) fn annotate(nodes: &mut BTreeMap<String, GpuNode>, roots: &[String], output: Rect, extent: Rect) {
    fn walk(nodes: &BTreeMap<String, GpuNode>, ids: &[String], domain: Rect, mut demand: Rect,
        boxes: &mut BTreeMap<String, Rect>) {
        if !bounded(domain) || !bounded(demand) { return; }
        for id in ids.iter().rev() {
            let Some(n) = nodes.get(id) else { continue; };
            if n.opacity <= 0. { continue; }
            let after = rounded(demand, domain);
            if after.empty() { return; }
            if after != domain { boxes.insert(id.clone(), after); }
            // Recurse only through the unconditional isolated-child lane.
            // In-place opaque fills, clips, masks, effects and pass-through
            // containers keep their original complete child targets.
            if !n.passthrough && !n.clip && !n.mask && n.mask_id.is_none()
                && n.fills.is_empty() && n.strokes.is_empty() && n.effects.is_empty() {
                let needed = demand.expand(2).intersect(n.rect);
                walk(nodes, &n.children, n.rect, needed, boxes);
            }
            // Every pointwise composite retains its bilinear neighbours,
            // including zero-weight loads. Never propagate rounded allocation
            // padding as additional logical demand at every sibling.
            demand = if n.passthrough || n.effects.iter().any(|e| e.visible && matches!(e.kind.as_str(), "background-blur" | "glass")) {
                domain
            } else { demand.expand(2).intersect(domain) };
        }
    }
    if !bounded(extent) || !bounded(output) { return; }
    let mut boxes = BTreeMap::new();
    walk(nodes, roots, extent, output.expand(2).intersect(extent), &mut boxes);
    for (id, r) in boxes { nodes.get_mut(&id).unwrap().suffix_box = Some(super::device_box(r)); }
}
