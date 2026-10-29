//! Source planning for radial filters, independent of their output padding.
//! Zoom may sample toward a distant focal point. Walk painter order backwards:
//! isolated foreground reads enlarge only that subtree's source; backdrop reads
//! additionally demand the preceding siblings. No cache/quality policy changes.
use crate::{
    font::Fonts,
    math::{Point, Rect, Transform},
    scene::{Document, Node},
};
use std::collections::HashMap;
const MAX_HALO: i32 = 2048;
fn active(n: &Node) -> bool {
    n.visible
        && n.effects
            .iter()
            .any(|e| e.visible && e.zoom_blur.is_some_and(|z| !z.is_identity()))
}
fn checked_rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Result<Rect, String> {
    if [x0, y0, x1, y1]
        .iter()
        .any(|v| !v.is_finite() || v.abs() > 536_870_000.)
        || x1 - x0 > 16_000_000.
        || y1 - y0 > 16_000_000.
    {
        return Err("Zoom support exceeds device coordinate budget".into());
    }
    let x = x0.floor() as i32;
    let y = y0.floor() as i32;
    Ok(Rect::new(
        x,
        y,
        (x1.ceil() as i32 - x).max(0) as u32,
        (y1.ceil() as i32 - y).max(0) as u32,
    ))
}
fn intersection(bounds: [f64; 4], r: Rect) -> Result<Rect, String> {
    let x0 = bounds[0].max(f64::from(r.x));
    let y0 = bounds[1].max(f64::from(r.y));
    let x1 = bounds[2].min(f64::from(r.right()));
    let y1 = bounds[3].min(f64::from(r.bottom()));
    if x0 >= x1 || y0 >= y1 {
        return Ok(Rect::default());
    }
    checked_rect(x0, y0, x1, y1)
}
fn finite_support(e: &crate::scene::Effect, scale: f64) -> Result<i32, String> {
    let value = match e.kind.as_str() {
        "color-controls" | "noise" => 0.,
        "gaussian-blur" | "motion-blur" => {
            if e.radius > 0. {
                3. * e.radius * scale + 2.
            } else {
                0.
            }
        }
        _ => {
            (e.blur_radius() * 2. + e.spread.abs() + e.x.abs() + e.y.abs() + e.material_halo())
                * scale
        }
    };
    if !value.is_finite() || value.ceil() > f64::from(MAX_HALO) {
        return Err("Zoom source filter halo exceeds 2048 device pixels".into());
    }
    Ok(value.ceil() as i32)
}
fn foreground_source(
    n: &Node,
    m: Transform,
    bounds: [f64; 4],
    mut region: Rect,
) -> Result<Rect, String> {
    for e in n
        .effects
        .iter()
        .rev()
        .filter(|e| e.visible && !matches!(e.kind.as_str(), "background-blur" | "glass"))
    {
        let Some(z) = e.zoom_blur else {
            region = region.expand(finite_support(e, m.max_scale())?);
            continue;
        };
        if z.is_identity() {
            continue;
        }
        let c = m.point(Point::new(n.width * z.center[0], n.height * z.center[1]));
        let t = 1. - (-f64::from(z.amount as f32) / 50.).exp();
        let x0 = f64::from(region.x);
        let y0 = f64::from(region.y);
        let x1 = f64::from(region.right());
        let y1 = f64::from(region.bottom());
        region = checked_rect(
            (x0.min(x0 + (c.x - x0) * t) - 1.).max(bounds[0]),
            (y0.min(y0 + (c.y - y0) * t) - 1.).max(bounds[1]),
            (x1.max(x1 + (c.x - x1) * t) + 1.).min(bounds[2]),
            (y1.max(y1 + (c.y - y1) * t) + 1.).min(bounds[3]),
        )?;
    }
    Ok(region)
}
struct Planner<'a> {
    doc: &'a Document,
    bounds: HashMap<String, ([f64; 4], Transform)>,
    extent: Rect,
    viewport: Rect,
}
impl Planner<'_> {
    fn include(&mut self, r: Rect) -> Result<(), String> {
        if r.empty() {
            return Ok(());
        }
        self.extent = self.extent.union(r);
        let v = self.viewport;
        let r = self.extent;
        if [
            v.x - r.x,
            v.y - r.y,
            r.right() - v.right(),
            r.bottom() - v.bottom(),
        ]
        .into_iter()
        .max()
        .unwrap_or(0)
            > MAX_HALO
        {
            return Err("Combined zoom source dependency halo exceeds 2048 device pixels".into());
        }
        Ok(())
    }
    fn siblings(&mut self, ids: &[String], mut needed: Rect) -> Result<(Rect, bool), String> {
        let mut reads_parent = false;
        for id in ids.iter().rev() {
            crate::render_cancellation::checkpoint()?;
            let n = &self.doc.nodes[id];
            if !n.visible || n.opacity <= 0. {
                continue;
            }
            let Some((bounds, m)) = self.bounds.get(id).copied() else {
                return Err("Missing zoom source bounds".into());
            };
            // Match the existing neutral-frame clip proof: descendants cannot
            // expose their effects outside the frame's own fill/stroke bounds.
            let bounds = if n.kind == "frame"
                && n.clip
                && !n.mask
                && n.blend == "normal"
                && n.effects
                    .iter()
                    .all(|e| !e.visible || e.zoom_blur.is_some_and(|z| z.is_identity()))
            {
                let (fill, stroke) = n.paths()?;
                let padding = (n
                    .strokes
                    .iter()
                    .filter(|s| s.visible)
                    .map(|s| crate::stroke::maximum_width(s) * 4. * m.max_scale())
                    .fold(0., f64::max))
                .ceil() as i32
                    + 4;
                let bound = fill
                    .control_bounds(m)
                    .union(stroke.control_bounds(m))
                    .expand(padding);
                [
                    f64::from(bound.x),
                    f64::from(bound.y),
                    f64::from(bound.right()),
                    f64::from(bound.bottom()),
                ]
            } else {
                bounds
            };
            let output = intersection(bounds, needed)?;
            if output.empty() {
                continue;
            }
            let source = foreground_source(n, m, bounds, output)?;
            self.include(source)?;
            let (prefix, children_read) = self.siblings(n.render_children(), source)?;
            // A child's backdrop can sample the node's own fills farther away.
            // Isolated groups terminate that read at their transparent base.
            self.include(prefix)?;
            if let Some(backdrop) = n.backdrop_effect() {
                let captured = prefix.expand(finite_support(backdrop, m.max_scale())?);
                self.include(captured)?;
                needed = needed.union(captured);
                reads_parent = true;
            } else if n.passes_backdrop() && children_read {
                needed = needed.union(prefix);
                reads_parent = true;
                self.include(needed)?;
            }
        }
        Ok((needed, reads_parent))
    }
}
pub(crate) fn has_zoom(doc:&Document,roots:&[String])->bool {
    if doc.schema_version < 19 {
        return false;
    }
    let mut stack = roots.iter().map(String::as_str).collect::<Vec<_>>();
    let mut found = false;
    while let Some(id) = stack.pop() {
        let n = &doc.nodes[id];
        if !n.visible {
            continue;
        }
        found |= active(n);
        stack.extend(n.render_children().iter().map(String::as_str));
    }
    found
}
pub(crate) fn scene_guard(doc:&Document,roots:&[String],camera:Transform,viewport:Rect,fonts:&Fonts)->Result<Option<Rect>,String>{
    if !has_zoom(doc,roots){return Ok(None)}
    scene_guard_active(doc,roots,camera,viewport,fonts).map(Some)
}
/// Caller holds an exact revision/page presence result; only the redundant
/// detection walk is skipped. All source planning and admission stay identical.
pub(crate) fn scene_guard_active(doc:&Document,roots:&[String],camera:Transform,viewport:Rect,fonts:&Fonts)->Result<Rect,String>{
    let bounds = crate::dirty_region::render_bounds_map(doc, roots, camera, fonts)?;
    let mut planner = Planner {
        doc,
        bounds,
        extent: viewport,
        viewport,
    };
    planner.siblings(roots, viewport)?;
    Ok(planner.extent)
}
