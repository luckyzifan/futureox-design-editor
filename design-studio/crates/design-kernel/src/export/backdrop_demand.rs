use super::{ExportPadding, checked_backdrop_padding, visit_backdrops};
use crate::{
    Engine, RenderOptions,
    fidelity::RasterProfile,
    geometry_snapshot::{Prepared, prepare_node_geometry},
    math::{Rect, Transform},
    memory::COMPOSITING_BYTES,
    scene::Document,
};
use std::collections::HashMap;

/// Lives for one immutable, resolved export. The normal padding rule keeps
/// its previous result wherever it fits. Only an overcounted analytic tile
/// needs to prove a smaller extent from its painter dependencies.
pub(super) struct BackdropDemand {
    entries: Vec<(Rect, f64)>,
    camera: Transform,
    prepared: Option<HashMap<String, Prepared>>,
}

impl BackdropDemand {
    pub(super) fn new(engine: &Engine, options: &RenderOptions) -> Result<Option<Self>, String> {
        let Some(doc) = &engine.doc else { return Ok(None) };
        if options.raster_profile != RasterProfile::Analytic
            || options.animation.is_some() || doc.color_management.is_some()
            || doc.nodes.values().any(|n| n.visible && n.effects.iter().any(|e| e.visible && e.kind == "zoom-blur"))
        {
            return Ok(None);
        }
        let page = doc.pages.iter().find(|p| p.id == options.page_id).ok_or("Page not found")?;
        let view = options.view;
        let camera = Transform([view.zoom, 0., 0., view.zoom, view.x, view.y]);
        let mut entries = Vec::new();
        visit_backdrops(doc, &page.children, camera, |rect, support| entries.push((rect, support)))?;
        Ok((entries.len() > 1).then_some(Self { entries, camera, prepared: None }))
    }

    pub(super) fn padding(&mut self, engine: &mut Engine, options: &RenderOptions, tile: Rect) -> Result<ExportPadding, String> {
        let search = tile.expand(2048);
        let total = self.entries.iter().filter(|(rect, _)| !rect.intersect(search).empty())
            .map(|(_, support)| support).sum();
        let previous_error = match checked_backdrop_padding(total, 1.) {
            Ok(padding) => return Ok(ExportPadding::Extra(padding)),
            Err(error) => error,
        };
        let doc = engine.doc.as_ref().ok_or("Load a document before exporting")?;
        let page = doc.pages.iter().find(|p| p.id == options.page_id).ok_or("Page not found")?;
        if self.prepared.is_none() {
            // Only dependencies inside this existing limit can be admitted.
            // The full export guard includes them with the same path flattening,
            // stroke and clip bounds the actual CPU painter already uses.
            let guard = Rect::new(0, 0, options.width, options.height).expand(2048);
            let mut prepared = HashMap::new();
            let mut segments = 0;
            for root in &page.children {
                prepare_node_geometry(root, self.camera, (doc, &engine.fonts, guard, false),
                    &mut engine.paths, &mut engine.local_strokes, &mut prepared, &mut segments)?;
            }
            self.prepared = Some(prepared);
        }
        let prepared = self.prepared.as_ref().unwrap();
        let mut input = tile;
        if !demand(doc, prepared, &page.children, tile, search, &mut input)? {
            return Err(previous_error);
        }
        let margin = [tile.x - input.x, tile.y - input.y, input.right() - tile.right(),
            input.bottom() - tile.bottom()].into_iter().max().unwrap();
        checked_backdrop_padding(f64::from(margin), 1.)?;
        // This rectangle already includes both the foreground and backdrop
        // reads. Keep its actual four edges instead of expanding it again.
        if input.pixels().saturating_mul(4 * std::mem::size_of::<crate::blend::Pixel>()) > COMPOSITING_BYTES {
            return Err("Compositing memory budget exceeded".into());
        }
        Ok(ExportPadding::Required(input))
    }
}

/// Walk each isolated group in reverse paint order. A backdrop grows the
/// demand on its earlier siblings only within the same target. A foreground
/// filter grows its own source extent. It cannot make unrelated backdrops
/// cumulative. The caller still renders the original scene and effects.
fn demand(
    doc: &Document, prepared: &HashMap<String, Prepared>, children: &[String],
    mut needed: Rect, domain: Rect, input: &mut Rect,
) -> Result<bool, String> {
    for (i, id) in children.iter().rev().enumerate() {
        if i % 64 == 0 { crate::render_cancellation::checkpoint()?; }
        let n = &doc.nodes[id];
        let Some(p) = prepared.get(id) else { continue };
        if !n.visible || n.opacity <= 0. { continue; }
        let output = needed.intersect(p.bounds);
        if output.empty() { continue; }
        if n.mask || n.passes_backdrop() || n.boolean_operation.is_some() || doc.mask_child(n).is_some()
            || p.matrix.inverse().is_err()
        {
            return Ok(false);
        }
        let mut visible = n.effects.iter().filter(|e| e.visible);
        if !n.render_children().is_empty() {
            if visible.next().is_some()
                || !demand(doc, prepared, n.render_children(), output, p.bounds, input)?
            {
                return Ok(false);
            }
        } else if let Some(fx) = n.backdrop_effect() {
            if fx.kind != "background-blur" || fx.gradient_blur.is_some() || fx.color_controls.is_some()
                || visible.any(|other| !std::ptr::eq(fx, other))
            {
                return Ok(false);
            }
            let covered = output.intersect(p.fill_program_bounds);
            if covered.empty() { continue; }
            let sigma = fx.backdrop_radius() * p.matrix.max_scale() / 2.;
            let reach = crate::effects::gaussian_box_radii(sigma)?.into_iter().sum::<u32>() as i32;
            let reads = covered.expand(reach + 2).intersect(p.bounds);
            *input = input.union(reads);
            needed = needed.union(reads.intersect(domain));
        } else {
            if visible.any(|effect| effect.gradient_blur.is_some()
                || !matches!(effect.kind.as_str(), "blur" | "gaussian-blur" | "shadow" | "inner-shadow"))
            {
                return Ok(false);
            }
            if p.halo > 0 {
                *input = input.union(output.expand(p.halo + 2));
            }
        }
    }
    Ok(true)
}
