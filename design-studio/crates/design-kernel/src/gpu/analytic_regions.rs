//! Exact device regions for isolated SDR analytic painters. The original
//! scene extent remains the logical zero boundary of every filter pass.
use super::{halo, opaque_interior};
use crate::{effects, geometry_snapshot::Prepared, math::Rect, scene::{Document, Effect, Node}};
use serde::Serialize;
use std::collections::HashMap;

const MAX_SURFACE_PIXELS: usize = 16_777_216;
const MAX_LATTICE: i64 = 1_048_576;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxAxis {
    pub output: Rect,
    pub radius: u32,
    pub axis: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxRegion {
    pub input: Rect,
    pub output: Rect,
    pub axes: Vec<BoxAxis>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectRegion {
    pub output: Rect,
    pub filter: BoxRegion,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRegion {
    #[serde(skip)]
    pub input: Rect,
    #[serde(skip)]
    pub omit_shadow: bool,
    pub output: Rect,
    pub effects: Vec<EffectRegion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<BoxRegion>,
}

pub(super) struct Plan {
    pub root: Rect,
    pub nodes: HashMap<String, NodeRegion>,
}

fn bounded(r: Rect) -> bool {
    r.pixels() <= MAX_SURFACE_PIXELS && r.w.max(r.h) <= 16_384 && [r.x, r.y, r.right(), r.bottom()].iter()
        .all(|v| i64::from(*v).abs() <= MAX_LATTICE)
}

fn expand_axis(r: Rect, radius: i32, axis: usize) -> Rect {
    if r.empty() { return r; }
    if axis == 0 { Rect::new(r.x - radius, r.y, r.w + 2 * radius as u32, r.h) }
    else { Rect::new(r.x, r.y - radius, r.w, r.h + 2 * radius as u32) }
}

fn box_region(radii: [u32; 3], source: Rect, output: Rect, domain: Rect) -> Option<BoxRegion> {
    if !bounded(output) { return None; }
    let mut bounds = source;
    let mut steps = Vec::new();
    for radius in radii.into_iter().filter(|r| *r > 0) {
        for axis in 0..2 {
            let input = bounds;
            bounds = expand_axis(bounds, radius as i32, axis).intersect(domain);
            steps.push((radius, axis, input, bounds));
        }
    }
    let mut need = output.intersect(bounds);
    let mut axes = Vec::new();
    for (radius, axis, input, _) in steps.into_iter().rev() {
        if need.empty() { break; }
        if !bounded(need) { return None; }
        axes.push(BoxAxis { output: need, radius, axis });
        // Box pass centres are integer-aligned. Keep the adjacent sample
        // too, including the original zero boundary at the legacy extent.
        need = expand_axis(need, radius as i32 + 1, axis).intersect(input);
    }
    axes.reverse();
    bounded(need).then_some(BoxRegion { input: need, output, axes })
}

fn radii(effect: &Effect, scale: f64) -> Option<[u32; 3]> {
    let sigma = effect.radius * scale;
    if effect.kind == "gaussian-blur" { effects::gaussian_box_radii_region(sigma).ok() }
    else { effects::gaussian_box_radii(sigma / 2.).ok() }
}

fn shift(r: Rect, x: f64, y: f64) -> Rect {
    if r.empty() { return r; }
    let left = r.x + x.floor() as i32;
    let top = r.y + y.floor() as i32;
    Rect::new(left, top, r.w + (x.ceil() - x.floor()) as u32, r.h + (y.ceil() - y.floor()) as u32)
}

fn bounded_color(value: &str) -> bool {
    crate::color::parse(value, crate::color::ColorSpace::Srgb).is_ok_and(|(space, rgb, alpha)| {
        matches!(space, crate::color::ColorSpace::Srgb | crate::color::ColorSpace::LinearSrgb)
            && rgb.iter().all(|v| (0. ..=1.).contains(v)) && (0. ..=1.).contains(&alpha)
    })
}

fn bounded_paint(paint: &crate::scene::Paint) -> bool {
    !paint.visible || paint.blend == "normal" && bounded_color(&paint.color) && match paint.kind.as_str() {
        "solid" => true,
        "linear" => paint.stops.iter().all(|stop| bounded_color(&stop.color)),
        _ => false,
    }
}

struct Walk<'a> {
    doc: &'a Document,
    prepared: &'a HashMap<String, Prepared>,
    legacy: Rect,
    nodes: HashMap<String, NodeRegion>,
}

impl Walk<'_> {
    fn list(&mut self, ids: &[String], mut demand: Rect, parent: Rect) -> Option<Rect> {
        for id in ids.iter().rev() {
            let n = &self.doc.nodes[id];
            if !n.visible || n.opacity == 0. { continue; }
            let Some(p) = self.prepared.get(id) else { continue; };
            if p.bounds.intersect(demand).empty() { continue; }
            if let Some(region) = self.node(n, p, demand)? {
                if let Some(capture) = &region.backdrop { demand = demand.union(capture.input.intersect(parent)); }
                if !bounded(demand) { return None; }
                self.nodes.insert(id.clone(), region);
            }
        }
        Some(demand)
    }

    fn node(&mut self, n: &Node, p: &Prepared, demand: Rect) -> Option<Option<NodeRegion>> {
        if n.mask || n.passes_backdrop() || self.doc.mask_child(n).is_some()
            || !n.fills.iter().all(bounded_paint)
            || !n.strokes.iter().all(|s| !s.visible || bounded_paint(&s.paint)) { return None; }
        let domain = self.legacy.intersect(p.bounds);
        let output = demand.intersect(domain);
        if output.empty() { return Some(None); }
        let visible: Vec<_> = n.effects.iter().filter(|e| e.visible).collect();
        if !n.render_children().is_empty() {
            if !visible.is_empty() { return None; }
            let input = self.list(n.render_children(), output, domain)?;
            return bounded(input).then_some(Some(NodeRegion {
                input, output, effects: Vec::new(), backdrop: None, omit_shadow: false,
            }));
        }
        let scale = p.matrix.max_scale();
        let omit_shadow = !visible.is_empty() && visible.iter().all(|e| e.kind == "shadow")
            && opaque_interior(n, p.matrix, output);
        let mut bounds = p.stroke_program_bounds.iter().fold(Rect::default(), |a, r| a.union(*r));
        if n.fills.iter().any(|paint| paint.visible) || n.backdrop_effect().is_some() {
            bounds = bounds.union(p.fill_program_bounds);
        }
        bounds = bounds.intersect(domain);
        if bounds.empty() { return Some(None); }
        if let [effect] = visible.as_slice() && effect.kind == "background-blur" {
            if effect.gradient_blur.is_some() || effect.color_controls.is_some() { return None; }
            let output = output.intersect(bounds);
            if output.empty() { return Some(None); }
            let backdrop = box_region(radii(effect, scale)?, domain, output, domain)?;
            return Some(Some(NodeRegion { input: output, output, effects: Vec::new(), backdrop: Some(backdrop), omit_shadow: false }));
        }
        let mut stages = Vec::new();
        for effect in visible.into_iter().filter(|_| !omit_shadow) {
            if effect.gradient_blur.is_some() || effect.spread != 0. || !bounded_color(&effect.color)
                || !matches!(effect.kind.as_str(), "blur" | "gaussian-blur" | "shadow" | "inner-shadow") { return None; }
            let weights = radii(effect, scale)?;
            let reach = weights.into_iter().sum::<u32>() as i32;
            let dx = (p.matrix.0[0] * effect.x + p.matrix.0[2] * effect.y) as f32 as f64;
            let dy = (p.matrix.0[1] * effect.x + p.matrix.0[3] * effect.y) as f32 as f64;
            if !dx.is_finite() || !dy.is_finite() || dx.abs().max(dy.abs()) > f64::from(halo(n, p.matrix)) { return None; }
            let filtered = bounds.expand(reach).intersect(domain);
            let next = match effect.kind.as_str() {
                "shadow" => bounds.union(shift(filtered, dx, dy).expand(2)).intersect(domain),
                "inner-shadow" => bounds,
                _ => filtered,
            };
            stages.push((effect, weights, bounds, dx, dy));
            bounds = next;
        }
        let output = output.intersect(bounds);
        if output.empty() { return Some(None); }
        let mut need = output;
        let mut effects = Vec::new();
        for (effect, weights, source, dx, dy) in stages.into_iter().rev() {
            let shadow = matches!(effect.kind.as_str(), "shadow" | "inner-shadow");
            let filter_output = if shadow { shift(need, -dx, -dy).expand(2).intersect(domain) } else { need };
            let filter = box_region(weights, source, filter_output, domain)?;
            let filtered_input = filter.input;
            effects.push(EffectRegion { output: need, filter });
            need = if shadow { need.intersect(source).union(filtered_input) } else { filtered_input };
        }
        if need.empty() { return Some(None); }
        effects.reverse();
        bounded(need).then_some(Some(NodeRegion { input: need, output, effects, backdrop: None, omit_shadow }))
    }
}

pub(super) fn plan(doc: &Document, roots: &[String], viewport: Rect, legacy: Rect,
    prepared: &HashMap<String, Prepared>) -> Option<Plan> {
    let mut walk = Walk { doc, prepared, legacy, nodes: HashMap::new() };
    let root = walk.list(roots, viewport.expand(2).intersect(legacy), legacy)?;
    Some(Plan { root, nodes: walk.nodes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn regional_boxes_preserve_transparent_edges_and_all_six_dependencies() {
        type Pixels = HashMap<(i32, i32), i64>;
        fn points(r: Rect) -> impl Iterator<Item = (i32, i32)> {
            (r.y..r.bottom()).flat_map(move |y| (r.x..r.right()).map(move |x| (x, y)))
        }
        fn box_pass(input: &Pixels, output: Rect, axis: usize, radius: u32) -> Pixels {
            let radius = radius as i32;
            points(output).map(|(x, y)| {
                let sum = (-radius..=radius).map(|tap| {
                    let point = if axis == 0 { (x + tap, y) } else { (x, y + tap) };
                    input.get(&point).copied().unwrap_or(0)
                }).sum();
                ((x, y), sum)
            }).collect()
        }
        let domain = Rect::new(-22, -15, 54, 38);
        let source = Rect::new(-16, -14, 18, 27);
        let output = Rect::new(-22, -15, 6, 9);
        let radii = [2, 3, 4];
        let mut full: Pixels = points(source).map(|(x, y)| ((x, y), i64::from((x * y).rem_euclid(17)))).collect();
        let regional = box_region(radii, source, output, domain).unwrap();
        let mut crop: Pixels = points(regional.input).map(|p| (p, full[&p])).collect();
        assert!(regional.input.pixels() < source.pixels());
        assert_eq!(regional.axes.len(), 6);
        for pass in regional.axes {
            full = box_pass(&full, domain, pass.axis, pass.radius);
            crop = box_pass(&crop, pass.output, pass.axis, pass.radius);
        }
        for p in points(output) {
            assert_eq!(full[&p], crop.get(&p).copied().unwrap_or(0));
        }
    }

    #[test]
    fn high_zoom_compound_blur_admits_only_bounded_display_surfaces() {
        let doc = json!({"schemaVersion":20,"id":"regional","name":"regional",
            "pages":[{"id":"p","name":"p","background":"#ffffff","children":["shape","frost"]}],
            "nodes":{
                "shape":{"id":"shape","kind":"ellipse","width":20,"height":25,"fills":[{"kind":"solid","color":"#2358ab"}],
                    "effects":[{"kind":"shadow","radius":2,"x":0.5,"color":"#000000"},{"kind":"gaussian-blur","radius":10,"color":"#000000"}]},
                "frost":{"id":"frost","kind":"ellipse","width":30,"height":27,"opacity":0.6,
                    "effects":[{"kind":"background-blur","radius":2.5,"color":"#000000"}]}
            }});
        let mut engine = crate::Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let mut request = json!({"pageId":"p","width":514,"height":514,"view":{"x":0.,"y":0.,"zoom":64.},
            "rasterProfile":"analytic","gpuViewport":{"x":256,"y":300,"w":514,"h":514}});
        assert!(engine.compile_gpu_request(&request.to_string()).is_err());
        request["gpuAnalyticRegions"] = json!(true);
        let scene = engine.compile_gpu_request(&request.to_string()).unwrap();
        let blur = scene.nodes["shape"].analytic_region.as_ref().unwrap();
        let frost = scene.nodes["frost"].analytic_region.as_ref().unwrap();
        assert!(scene.extent.pixels() < MAX_SURFACE_PIXELS);
        assert_eq!(blur.effects.len(), 2);
        assert!(blur.effects[1].filter.axes.iter().all(|pass| bounded(pass.output)));
        assert!(blur.effects[1].filter.axes.iter().any(|pass| pass.radius > 512));
        assert!(frost.backdrop.is_some());
        assert_eq!(scene.output, Some(Rect::new(256, 300, 514, 514)));
    }
}
