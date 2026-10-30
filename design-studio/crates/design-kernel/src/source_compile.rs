//! Native source compilation over an immutable resolved demand projection.
//! Complete authored data remains in the lane owner for edits, exports and
//! unsupported requests. The compile engine never receives cold node payloads.
use crate::{
    Engine, RenderOptions,
    gpu::{PageProperties, SourceCompileContext},
    margin_index::MarginIndex,
    math::{Rect, Transform},
    scene_demand::Catalog,
    scene_store::Descriptor,
};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::AtomicBool};
const CACHE: usize = 64 * 1024 * 1024;
struct Query {
    options: RenderOptions,
    prepare: Rect,
    page_background: bool,
}
impl Query {
    fn parse(owner: &Engine, request: &str) -> Result<Option<Self>, String> {
        let mut value: Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
        let object = value
            .as_object_mut()
            .ok_or("Render options must be an object")?;
        // New sampling/capture policies must be reviewed before using a
        // projection. Unknown options retain the complete compiler contract.
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "pageId"
                    | "width"
                    | "height"
                    | "view"
                    | "transparent"
                    | "grid"
                    | "pixelPreview"
                    | "rasterProfile"
                    | "interactiveEffects"
                    | "checkerboard"
                    | "animation"
                    | "gpuRoots"
                    | "gpuNeutralPageGroup"
                    | "gpuPageBackground"
                    | "gpuGaussianRegions"
                    | "gpuGaussianReduction"
                    | "gpuPainterSupport"
                    | "gpuPainterCaptureReads"
                    | "gpuViewport"
                    | "captureViewport"
                    | "prepareViewport"
                    | "frameResources"
            )
        }) {
            return Ok(None);
        }

        if object.contains_key("gpuRoots")
            || object.get("gpuPainterSupport") == Some(&json!(true))
            || object.get("gpuPainterCaptureReads") == Some(&json!(true))
        {
            return Ok(None);
        }
        if !matches!(object.remove("gpuNeutralPageGroup"),None|Some(Value::Bool(false))){return Ok(None)}
        if !matches!(object.remove("gpuGaussianRegions"),None|Some(Value::Bool(_))){return Ok(None)}
        if object.remove("gpuGaussianReduction").is_some_and(|v|!matches!(v.as_u64(),Some(0|2|4|8))){return Ok(None)}
        let background = object.remove("gpuPageBackground");
        let region = object.remove("gpuViewport");
        let capture = object.remove("captureViewport");
        let is_capture = capture.is_some();
        if region.is_some() && capture.is_some() {
            return Ok(None);
        }
        let Some(region) = region.or(capture) else {
            return Ok(None);
        };
        let region: Rect = serde_json::from_value(region).map_err(|e| e.to_string())?;
        let prepare: Rect = object
            .remove("prepareViewport")
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or(region);
        object.remove("frameResources");
        object.remove("gpuPainterSupport");
        object.remove("gpuPainterCaptureReads");
        let options = owner.parse_options(value)?;
        if options.animation.is_some()
            || options.pixel_preview.is_some()
            || options.raster_profile != crate::fidelity::RasterProfile::FigmaSubpixel
            || options.interactive_effects
        {
            return Ok(None);
        }
        let valid = |r: Rect, max: u32| {
            !r.empty()
                && r.w <= max
                && r.h <= max
                && i64::from(r.x).abs() <= 16_000_000
                && i64::from(r.y).abs() <= 16_000_000
        };
        if !valid(region, if is_capture { 8192 } else { 514 })
            || is_capture && region.pixels() > 8_388_608
            || !valid(prepare, 32_000_000)
            || prepare.intersect(region) != region
        {
            return Ok(None);
        }
        if !(0.001..=crate::renderer::MAX_CANVAS_SAMPLE_SCALE).contains(&options.view.zoom)
            || ![options.view.x, options.view.y]
                .iter()
                .all(|v| v.is_finite())
        {
            return Ok(None);
        }
        if !matches!(background, None | Some(Value::Bool(_))) {
            return Ok(None);
        }
        Ok(Some(Self {
            options,
            prepare,
            page_background: background == Some(Value::Bool(true)),
        }))
    }
}
struct Plan {
    catalog: Arc<Catalog>,
    margin: Option<Arc<MarginIndex>>,
    properties: PageProperties,
    backdrop: bool,
    stage: String,
    page: String,
    children: Arc<Vec<String>>,
    padding: Option<(u64, i32)>,
}
pub(crate) struct Runtime {
    key: Option<(u64, bool, bool)>,
    plan: Option<Plan>,
    declined: Option<&'static str>,
    compiler: Option<Engine>,
    units: Vec<usize>,
    base_units: Vec<usize>,
    authored_nodes: usize,
    epoch: u64,
    active: bool,
    rebuilds: u64,
    reuses: u64,
    margin_evaluations: u64,
    pub(crate) stats: Value,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            key: None,
            plan: None,
            declined: None,
            compiler: None,
            units: vec![],
            base_units: vec![],
            authored_nodes: 0,
            epoch: 0,
            active: false,
            rebuilds: 0,
            reuses: 0,
            margin_evaluations: 0,
            stats: Value::Null,
        }
    }
}
impl Runtime {
    fn full(&mut self, owner: &mut Engine, request: &str, reason: &str) -> Result<Vec<u8>, String> {
        owner.frame_scene.limit_retention(None);
        if self.active {
            owner.invalidate_frame_scene_request();
            self.active = false;
        }
        self.compiler = None;
        self.units.clear();
        self.base_units.clear();
        if let Some(plan) = &mut self.plan {
            plan.margin = None;
        }
        self.stats = json!({"mode":"complete","reason":reason,"projectionRebuilds":self.rebuilds,"projectionReuses":self.reuses});
        let result = owner.compile_gpu_packet_request(request);
        if owner.static_scene_revision() == self.key {
            if let Some(plan) = &mut self.plan {
                plan.margin = owner
                    .world_support
                    .as_ref()
                    .filter(|cache| cache.page == plan.page)
                    .and_then(|cache| cache.margin.clone());
            }
        }
        result
    }
    pub(crate) fn compile(
        &mut self,
        owner: &mut Engine,
        descriptor: &Descriptor,
        stage: &str,
        page: &str,
        request: &str,
    ) -> Result<Vec<u8>, String> {
        crate::render_cancellation::checkpoint()?;
        let Some(query) = Query::parse(owner, request)? else {
            return self.full(owner, request, "request-contract");
        };
        if query.options.page_id != page {
            return self.full(owner, request, "different-page");
        }
        owner.prepare_frame(&query.options)?;
        owner.resolve_layout()?;
        let key = owner.static_scene_revision();
        if key.is_none() {
            return self.full(owner, request, "non-static-source");
        }
        if self.key != key {
            if self.active {
                owner.invalidate_frame_scene_request();
                self.active = false;
            }
            self.compiler = None;
            self.plan = None;
            self.units.clear();
            self.base_units.clear();
            self.declined = None;
            self.key = None;
            owner.release_source_compile_caches();
            // Reclaim the old optional transfer cache before reserving the
            // shared geometry allowance. Do not reset scope/sequence/IDs.
            owner.frame_scene.limit_retention(Some(0));
            let catalog = match Catalog::from_engine(
                owner,
                descriptor,
                stage,
                &AtomicBool::new(false),
                CACHE.saturating_sub(owner.frame_scene.bytes()),
            ) {
                Ok(catalog) => Some(catalog),
                Err(e) if e == "Scene demand requires the neutral source stage" => None,
                Err(e) => return Err(e),
            };
            if let Some(catalog) = catalog.filter(|c| c.compile_supported()) {
                let doc = owner.doc.as_ref().unwrap();
                let roots = &doc
                    .pages
                    .iter()
                    .find(|p| p.id == page)
                    .ok_or("Missing source page")?
                    .children;
                let properties = PageProperties::build(doc, roots);
                if properties.has_zoom() {
                    self.declined = Some("radial-read-domain");
                } else if let Some(margin) =
                    MarginIndex::build(doc, roots, CACHE.saturating_sub(owner.frame_scene.bytes()))?
                {
                    self.plan = Some(Plan {
                        catalog,
                        margin: Some(Arc::new(margin)),
                        properties,
                        backdrop: crate::fidelity::has_backdrop(doc, &query.options),
                        stage: stage.into(),
                        page: page.into(),
                        children: Arc::new(doc.nodes[stage].children.clone()),
                        padding: None,
                    });
                } else {
                    self.declined = Some("context-budget");
                }
            } else {
                self.declined = Some("global-source-contract");
            }
            self.key = key;
        }
        let Some(plan) = &mut self.plan else {
            return self.full(owner, request, self.declined.unwrap_or("no-plan"));
        };
        let view = query.options.view;
        let camera = Transform([view.zoom, 0., 0., view.zoom, view.x, view.y]);
        let page_paint_rects=if query.page_background {
            let bounds=plan.catalog.page_paint_rects(owner.doc.as_ref().unwrap(),&owner.fonts,
                Transform([view.zoom,0.,0.,view.zoom,0.,0.]));
            crate::render_cancellation::checkpoint()?;
            bounds.map(|bounds|bounds.into_iter().map(|b|[b[0]+view.x,b[1]+view.y,b[2]+view.x,b[3]+view.y]).collect::<Vec<_>>())
        } else {None};
        let mut demand = plan.catalog.viewport_for_compile(
            camera, query.prepare.expand(4), &AtomicBool::new(false),
        )?;
        let demand_stats=demand.stats();
        // A complete demand stays on the old compiler without destroying its
        // warm geometry on every tile. Only an actual subset needs the handoff.
        if demand_stats.required_nodes==demand_stats.total_nodes {
            return self.full(owner,request,"complete-demand");
        }
        if !self.active {
            owner.release_source_compile_caches();
        }
        if plan.margin.is_none() {
            owner.frame_scene.limit_retention(Some(0));
            let doc = owner.doc.as_ref().unwrap();
            plan.margin = MarginIndex::build(
                doc,
                &doc.pages.iter().find(|p| p.id == page).unwrap().children,
                CACHE.saturating_sub(owner.frame_scene.bytes()),
            )?
            .map(Arc::new);
        }
        let Some(margin) = plan.margin.clone() else {
            return self.full(owner, request, "context-budget");
        };
        if margin.bytes() > CACHE {
            // Do not retain two optional geometry caches beside the full path.
            self.compiler = None;
            self.plan = None;
            self.declined = Some("context-budget");
            drop(margin);
            return self.full(owner, request, "context-budget");
        }
        owner.frame_scene.limit_retention(Some(CACHE-margin.bytes()));
        let doc = owner.doc.as_ref().unwrap();

        // Only zoom affects affine linear coefficients and effect_halo.
        // Pan translation never participates in max_scale; retain the exact
        // original evaluation for this source revision and zoom bit pattern.
        let padding = if let Some((zoom, value)) = plan
            .padding
            .filter(|(zoom, _)| *zoom == view.zoom.to_bits())
        {
            let _ = zoom;
            value
        } else {
            let Some(value) = margin.padding(doc, camera)? else {
                drop(margin);
                return self.full(owner, request, "margin-scratch");
            };
            plan.padding = Some((view.zoom.to_bits(), value));
            self.margin_evaluations += 1;
            value
        };
        if !(0..=16_000_000).contains(&padding) {
            drop(margin);
            return self.full(owner, request, "effect-coordinate-domain");
        }
        let base_units = demand.unit_key();
        let catalog = plan.catalog.clone();
        let properties = plan.properties;
        let backdrop = plan.backdrop;
        let stage_id = plan.stage.clone();
        let stage_children = plan.children.clone();
        let source = owner.doc.as_ref().unwrap().clone();
        let mut expansions = 0;
        loop {
            let demand_stats = demand.stats();
            if demand_stats.required_nodes == demand_stats.total_nodes {
                drop(margin);
                return self.full(owner, request, "complete-demand");
            }
            let units = demand.unit_key();
            // At most one prior demand is retained, never the union of every
            // visited viewport. Expansion replaces it with this exact set.
            let reuse = expansions == 0
                && self.base_units == base_units
                && units.iter().all(|u| self.units.binary_search(u).is_ok());
            if self.compiler.is_none() || !reuse {
                let nodes = demand.resolved_nodes(&source)?;
                self.epoch = self
                    .epoch
                    .checked_add(1)
                    .ok_or("Source projection epoch exhausted")?;
                let compiler = owner.resolved_source_compiler(nodes, page, self.epoch)?;
                crate::render_cancellation::checkpoint()?;
                self.compiler = Some(compiler);
                self.authored_nodes = demand_stats.required_nodes;
                self.units = units;
                self.base_units = base_units.clone();
                self.rebuilds += 1;
                owner.invalidate_frame_scene_request();
            } else {
                self.reuses += 1;
            }
            if !self.active {
                owner.invalidate_frame_scene_request();
                self.active = true;
            }
            let compiler = self.compiler.as_mut().unwrap();
            compiler.source_compile_context = Some(SourceCompileContext {
                page: page.into(),
                camera: (view.x, view.y, view.zoom),
                properties,
                padding,
                backdrop,
                stage: stage_id.clone(),
                stage_children: stage_children.clone(),
                reserved_bytes: margin.bytes(),
                page_paint_rects: page_paint_rects.clone(),
            });
            let active_units = &self.units;
            let mut expanded = None;
            // One wire-resource owner; scope expansion must finish before
            // minting transfer IDs or exposing a packet to the renderer.
            std::mem::swap(&mut compiler.frame_scene, &mut owner.frame_scene);
            let result = compiler.compile_gpu_packet_request_checked(request, |scene| {
                let next = catalog.viewport_for_compile(
                    camera,
                    query.prepare.union(scene.extent).expand(4),
                    &AtomicBool::new(false),
                )?;
                if next
                    .unit_key()
                    .iter()
                    .any(|u| active_units.binary_search(u).is_err())
                {
                    expanded = Some(next);
                    return Err("SOURCE_DEMAND_REPLAN".into());
                }
                Ok(())
            });
            let cache = compiler.gpu_compile_cache_stats();
            std::mem::swap(&mut compiler.frame_scene, &mut owner.frame_scene);
            if let Some(next) = expanded {
                expansions += 1;
                if expansions > 1 {
                    drop(margin);
                    return self.full(owner, request, "scope-convergence");
                }
                demand = next;
                continue;
            }
            self.stats = json!({"mode":"demand","sourceNodes":descriptor.nodes,"residentAuthoredNodes":self.authored_nodes,
                "resolvedCompileNodes":compiler.doc.as_ref().unwrap().nodes.len(),"projectionRebuilds":self.rebuilds,"projectionReuses":self.reuses,
                "scopeExpansions":expansions,"excludedNodePayloadCopies":0,"residentAuthority":true,"globalPadding":padding,
                "globalMarginEvaluations":self.margin_evaluations,"contextMarginBytes":margin.bytes(),"cache":cache});
            if owner.frame_scene.bytes().saturating_add(margin.bytes()) > CACHE {
                self.compiler = None;
                if let Some(plan) = &mut self.plan {
                    plan.margin = None;
                }
            }
            return result;
        }
    }
}

#[cfg(test)]
mod tests;
