use crate::geometry_snapshot::{Prepared, effect_halo, prepare_node_geometry};
use crate::{
    blend::{Pixel, Surface, over},
    effects,
    font::Fonts,
    math::{Point, Rect, Transform},
    memory::{Allocation, Budget, COMPOSITING_BYTES},
    paint::{Images, Sampler},
    path::Contour,
    raster::{Coverage, Mask, RasterWorkspace, SampleMasks},
    scene::{Document, Node, Paint},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

/// Device-pixel camera scale for 2%–25600% navigation, including DPR.
/// Pixel, path, coordinate, effect and allocation guards remain independent.
pub(crate) const MAX_CANVAS_SAMPLE_SCALE: f64 = 4096.;

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct View {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<crate::animation::Sample>,
    pub page_id: String,
    pub width: u32,
    pub height: u32,
    pub view: View,
    #[serde(default)]
    pub transparent: bool,
    #[serde(default)]
    pub grid: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pixel_preview: Option<u8>,
    #[serde(default)]
    pub raster_profile: crate::fidelity::RasterProfile,
    /// Legacy interactive tier for explicit reference/compile APIs. Normal
    /// managed display through `render` always preserves full sampling and
    /// effects, and reports resource errors instead of silently degrading.
    #[serde(default)]
    pub interactive_effects: bool,
    /// Canvas chrome tier: paint the checkerboard under content instead of
    /// the flat page background (screen-anchored 16px cells, #fff/#eee).
    #[serde(default)]
    pub checkerboard: bool,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub effect_layers: usize,
    pub backdrop_reads: usize,
    pub nodes: usize,
    pub culled: usize,
    pub path_segments: usize,
    pub shaded_pixels: usize,
    pub peak_layer_pixels: usize,
    pub allocated_layer_pixels: usize,
    pub peak_compositing_bytes: usize,
}
/// Figma-shape compositing ledger (see `Engine::compositing_ledger`).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositingLedger {
    pub scene_peak_bytes: usize,
    pub tile_resident_bytes: usize,
    pub rendered_tile_vram_mb: u32,
    pub total_vram_mb: u32,
    pub tile_vram_ratio: f32,
    pub budget_rejections: u32,
    pub last_rejection: Option<RejectionInfo>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectionInfo {
    pub requested_bytes: usize,
    pub live_bytes: usize,
}
/// Four-bucket GPU memory ledger export (Figma `CorePerfInfo`'s four i64
/// counters, `FullscreenPerfInfo::getRendererMemoryBreakdown` wasm #46442 /
/// `getRendererGpuMemory` #46443): live bytes per bucket, per-bucket peaks,
/// the four-bucket total high-water mark, the `needs_free` pressure flag
/// (wasm #39291), and pressure events. Diagnostic only — admission stays
/// with the allocating side's own caps; the ledger only records facts.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMemoryBreakdown {
    pub texture_bytes: u64,
    pub buffer_bytes: u64,
    pub fixed_array_bytes: u64,
    pub blob_bytes: u64,
    pub peak_texture_bytes: u64,
    pub peak_buffer_bytes: u64,
    pub peak_fixed_array_bytes: u64,
    pub peak_blob_bytes: u64,
    pub peak_total_bytes: u64,
    pub total_bytes: u64,
    pub limit_bytes: u64,
    pub needs_free: bool,
    pub free_events: u32,
    pub rejections: u32,
    /// Figma's five memory telemetry axes,
    /// derived from our four buckets; mapping recorded in
    /// `render_telemetry::FigmaGpuMemoryAxes`.
    #[serde(flatten)]
    pub figma_axes: crate::render_telemetry::FigmaGpuMemoryAxes,
}
impl Stats {
    pub(crate) fn accumulate(&mut self, other: &Self) {
        self.effect_layers += other.effect_layers;
        self.backdrop_reads += other.backdrop_reads;
        self.nodes += other.nodes;
        self.culled += other.culled;
        self.path_segments += other.path_segments;
        self.shaded_pixels += other.shaded_pixels;
        self.allocated_layer_pixels += other.allocated_layer_pixels;
        self.peak_layer_pixels = self.peak_layer_pixels.max(other.peak_layer_pixels);
        self.peak_compositing_bytes = self
            .peak_compositing_bytes
            .max(other.peak_compositing_bytes);
    }
}
/// Render snapshots share immutable authored/derived documents. Mutating an
/// engine detaches its document, so worker and interaction edits remain isolated.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub(crate) struct SharedDocument(Arc<Document>);
impl From<Document> for SharedDocument {
    fn from(document: Document) -> Self { Self(Arc::new(document)) }
}
impl From<SharedDocument> for Document {
    fn from(document: SharedDocument) -> Self { Arc::unwrap_or_clone(document.0) }
}
impl std::ops::Deref for SharedDocument {
    type Target = Document;
    fn deref(&self) -> &Document { &self.0 }
}
impl std::ops::DerefMut for SharedDocument {
    fn deref_mut(&mut self) -> &mut Document { Arc::make_mut(&mut self.0) }
}

// A size receipt is tied to the exact immutable authored allocation, not
// Document::PartialEq, a caller-supplied revision, or a lossy content hash.
// Weak does not keep the document alive or add a strong owner. Arc::make_mut
// detaches even a sole strong owner when a Weak exists, so an unaccounted COW
// mutation cannot silently retain this identity. Never dereference the pointer.
#[derive(Clone)]
struct RetainedSourceSize {
    source: std::sync::Weak<Document>,
    serialized_bytes: usize,
}
impl RetainedSourceSize {
    fn new(source: &SharedDocument, serialized_bytes: usize) -> Self {
        Self { source: Arc::downgrade(&source.0), serialized_bytes }
    }
    fn bytes_for(&self, source: &SharedDocument) -> Option<usize> {
        (self.source.as_ptr() == Arc::as_ptr(&source.0)).then_some(self.serialized_bytes)
    }
}

pub struct Engine {
    source_doc: Option<SharedDocument>,
    source_doc_bytes: Option<usize>,
    // Exact count from the last successful generic retained patch, for this
    // unchanged authored source only. This is NOT fast-lane eligibility:
    // keep source_doc_bytes and its original Some/None transitions unchanged.
    // Only the direct-interaction recount fallback may read this receipt.
    retained_source_size: Option<RetainedSourceSize>,
    text_base: Option<SharedDocument>,
    animation_base: Option<SharedDocument>,
    animation_sample: Option<crate::animation::Sample>,
    layout_dirty: bool,
    pub(crate) doc: Option<SharedDocument>,
    pub fonts: Fonts,
    images: Images,
    pub(crate) paths: HashMap<String, crate::path::SharedPaths>,
    pub(crate) local_strokes: crate::resident_strokes::ResidentStrokes,
    pub(crate) stats: Stats,
    /// Figma-shape compositing ledger state (see `compositing_ledger`):
    /// cross-render scene peak, pressure events from budget rejections.
    scene_peak_bytes: usize,
    budget_rejections: u32,
    last_rejection: Option<(usize, usize)>,
    /// Four-bucket GPU memory ledger (see `gpu_memory_breakdown`). The
    /// kernel itself allocates no GPU memory; the ledger is shared state a
    /// host installs into the allocating device (`NativeGpu`) so the export
    /// reports real allocation-side facts, never estimates.
    gpu_memory: crate::memory::GpuMemoryLedger,
    /// Linear-tile residency for the interactive tier (Figma's tile reuse):
    /// world-anchored 512² f32 tiles at the zoom bucket, keyed by content
    /// revision, reused across frames so pans and repeats re-raster nothing.
    /// The exact `render_linear` path never touches this cache.
    linear_tiles: std::collections::HashMap<(usize, [i32; 2]), (u64, std::sync::Arc<Vec<Pixel>>)>,
    linear_tiles_order: Vec<(usize, [i32; 2])>,
    linear_tiles_options: Option<(
        String,
        crate::render_instruction::InstructionOptions,
        crate::render_instruction::ColorSpaceId,
    )>,
    /// Bumped whenever the document or fonts change the flattened-geometry
    /// lineage, keying the camera-scoped prepare cache in `gpu.rs`.
    pub(crate) geo_revision: u64,
    // A one-step, engine-owned proof. Arbitrary patches, font changes and
    // skipped poses cannot borrow it: both revisions must match the consumer.
    pub(crate) interaction_transform_revision: Option<(u64, u64, Vec<String>)>,
    pub(crate) camera_prepare: Option<crate::gpu::CameraPrepare>,
    pub(crate) world_support: Option<crate::world_support::Cache>,
    // Private render-only projection context, never deserialized from a file
    // or request and never installed into an authored/editable engine.
    pub(crate) source_compile_context: Option<crate::gpu::SourceCompileContext>,
    // Move, never duplicate, the prior camera until the new derived document
    // is known. Only identical topology/configuration can retain its clean nodes.
    pending_camera: Option<(SharedDocument, crate::gpu::CameraPrepare, bool)>,
    // Layout dependency proof does not require a warm camera. The old source
    // must already equal its resolved document; otherwise retain full resolve.
    pending_layout: Option<SharedDocument>,
    pub(crate) camera_residency: crate::gpu::CameraResidency,
    pub(crate) frame_scene: crate::gpu::FrameSceneContext,
    pub(crate) page_support: Option<((u64,String,u64,bool),Option<Vec<[f64;4]>>)>,
    render_index: Option<Arc<crate::render_index::RenderIndex>>,
    /// Sketch-parity tiled renderer state (tile residency, instructions,
    /// caches, telemetry). Lazily created so export-only engines pay nothing.
    tiled: Option<crate::tiled_renderer::TiledRenderer>,
}
impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
impl Engine {
    pub fn new() -> Self {
        Self::with_fonts(Fonts::new())
    }
    /// Independent document/render state with shared, prevalidated font
    /// resources. Loading or editing one engine cannot mutate another engine.
    pub fn with_fonts(fonts: Fonts) -> Self {
        Self {
            source_doc: None,
            source_doc_bytes: None,
            retained_source_size: None,
            text_base: None,
            animation_base: None,
            animation_sample: None,
            layout_dirty: true,
            doc: None,
            fonts,
            images: Images::default(),
            paths: HashMap::new(),
            local_strokes: Default::default(),
            stats: Stats::default(),
            scene_peak_bytes: 0,
            budget_rejections: 0,
            last_rejection: None,
            gpu_memory: crate::memory::GpuMemoryLedger::default(),
            linear_tiles: std::collections::HashMap::new(),
            linear_tiles_order: Vec::new(),
            linear_tiles_options: None,
            geo_revision: 0,
            interaction_transform_revision: None,
            camera_prepare: None,
            world_support: None,
            source_compile_context: None,
            pending_camera: None,
            pending_layout: None,
            camera_residency: crate::gpu::CameraResidency::default(),
            frame_scene: crate::gpu::FrameSceneContext::default(),
            page_support: None,
            render_index: None,
            tiled: None,
        }
    }
    pub fn load_font(&mut self, data: &[u8]) -> Result<(), String> {
        self.prepare_animation(None)?;
        self.fonts.load(data)?;
        self.layout_dirty = true;
        self.pending_camera = None;
        self.pending_layout = None;
        self.paths.clear();
        self.geo_revision += 1;
        self.camera_prepare = None;
        self.camera_residency.clear();
        self.world_support = None;
        self.source_compile_context = None;
        Ok(())
    }
    pub fn color_settings(&self) -> Option<crate::color::ColorSettings> {
        self.doc.as_ref().and_then(|d| d.color_management)
    }
    pub(crate) fn static_scene_revision(&self) -> Option<(u64,bool,bool)> {
        let source=self.source_doc.as_ref()?;
        (!self.layout_dirty&&source.animations.is_empty()&&self.animation_sample.is_none())
            .then(||(self.geo_revision,self.fonts.glyph_origin_quantization(),self.image_mips()))
    }
    /// Rendering-side glyph-origin quantisation (Sketch's
    /// `allowFontSubpixelQuantization` counterpart). Default off; toggling
    /// does not bump the content revision because layout and caret geometry
    /// keep the shaped fractional grid — hosts opt in per presentation.
    pub fn set_text_quantization(&mut self, on: bool) {
        self.fonts.set_glyph_origin_quantization(on);
    }
    pub fn image_data(&mut self, uri: &str) -> Result<Arc<Surface>, String> {
        self.images.image(uri)
    }
    pub fn image_at_level(&mut self, uri: &str, level: u32) -> Result<Arc<Surface>, String> {
        self.images.image_at(uri, level)
    }
    pub fn set_image_mips(&mut self, mips: bool) {
        self.images.set_mip_enabled(mips);
    }
    pub fn image_mips(&self) -> bool {
        self.images.mips_enabled()
    }
    /// Compatibility hook: normal display no longer memoises quality loss.
    pub fn clear_degraded_scopes(&mut self) {}
    pub fn load_document(&mut self, json: &str) -> Result<(), String> {
        crate::capacity::check_document_bytes(json.len())?;
        let doc: Document = serde_json::from_str(json).map_err(|e| e.to_string())?;
        self.install_document(doc)
    }
    /// Native source storage supplies an already parsed complete model. Its
    /// logical byte size is independent of a JS/WASM transfer allowance; all
    /// ordinary scene, font, layout and rendering validation still applies.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn load_source_document(&mut self, document: Document) -> Result<(), String> {
        // Native indexed source navigation has no whole-document edit receipt.
        // Validation is mandatory; an optional normalized JSON size used only
        // by the small-edit fast path need not serialize the whole source here.
        self.install_document_policy(document,false,false)
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn release_source_compile_caches(&mut self){
        self.camera_prepare=None;self.world_support=None;self.camera_residency.clear();self.paths.clear();
        self.local_strokes=Default::default();self.page_support=None;
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn authored_document(&self)->Option<&Document>{self.source_doc.as_deref()}
    #[cfg(not(target_arch="wasm32"))]
    pub(crate) fn cold_source_shell(&self,settings:Option<crate::color::ColorSettings>)->Result<Engine,String> {
        let mut next=Engine::with_fonts(self.fonts.with_resources(&Default::default())?);
        next.set_image_mips(self.image_mips());next.images.set_color_settings(settings);next.gpu_memory=self.gpu_memory.clone();Ok(next)
    }
    #[cfg(all(not(target_arch="wasm32"),feature="mapped-source-snapshot"))]
    pub(crate) fn park_source_authority(&mut self) {
        // An immutable source still owns every record on disk. Retire only
        // materialized CPU authority; keep the one live transfer/resource scope.
        self.source_doc=None;self.doc=None;self.source_doc_bytes=None;self.retained_source_size=None;
        self.text_base=None;self.animation_base=None;self.animation_sample=None;self.layout_dirty=true;
        self.pending_camera=None;self.pending_layout=None;self.render_index=None;self.tiled=None;
        self.linear_tiles.clear();self.linear_tiles_order.clear();self.linear_tiles_options=None;
        self.release_source_compile_caches();
    }
    /// A private render working set, only after an authenticated archive has
    /// proved independent root closure. Never installed as a preparation lane's
    /// authored state; edits/exports materialize that lane's complete source.
    #[cfg(all(not(target_arch="wasm32"),feature="mapped-source-snapshot"))]
    pub(crate) fn resolve_source_projection(&mut self,document:Document,revision:u64)->Result<Engine,String> {
        let mut compiler=Engine::with_fonts(self.fonts.clone());compiler.images=self.images.clone();
        compiler.load_source_document(document)?;compiler.resolve_layout()?;compiler.geo_revision=revision;
        self.fonts=compiler.fonts.clone();self.images=compiler.images.clone();Ok(compiler)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn resolved_source_compiler(&self, nodes:std::collections::BTreeMap<String,crate::scene::Node>, page_id:&str, revision:u64)->Result<Engine,String>{
        let source=self.doc.as_ref().ok_or("Missing resolved source")?;
        let page=source.pages.iter().find(|p|p.id==page_id).ok_or("Missing source page")?.clone();
        // All authored metadata stays in the complete owner. This private
        // scene is already resolved, keeps derived paths/IDs verbatim, and
        // can only be used by the native source compiler, never edit/export.
        let document=Document{fd_compatibility:None,reviews:vec![],design_system:None,prototype:None,
            schema_version:source.schema_version,color_management:source.color_management,raster_profile:source.raster_profile,
            id:source.id.clone(),name:source.name.clone(),pages:vec![page],nodes,fonts:Default::default(),animations:vec![]};
        let mut compiler=Engine::new();compiler.fonts=self.fonts.clone();compiler.images=self.images.clone();
        let document=SharedDocument::from(document);compiler.source_doc=Some(document.clone());compiler.doc=Some(document);
        compiler.layout_dirty=false;compiler.geo_revision=revision;Ok(compiler)
    }
    pub fn apply_document_patch(
        &mut self,
        patch: &crate::editing::DocumentPatch,
    ) -> Result<(), String> {
        self.apply_document_patch_with_damage(patch).map(|_| ())
    }
    pub fn apply_document_patch_with_damage(
        &mut self,
        patch: &crate::editing::DocumentPatch,
    ) -> Result<crate::dirty_region::PatchDamage, String> {
        if patch.nodes.len()<=16&&self.can_retain_interaction(patch,true){
            let transforms=patch.nodes.iter().map(|(id,node)|(id.clone(),node.as_ref().unwrap().transform)).collect();
            if let Some(damage)=crate::dirty_region::resolved_leaf_pose_damage(self.doc.as_ref().unwrap(),
                &self.render_index.as_ref().unwrap().parents,&transforms,&self.fonts){
                // The existing pose entry validates changed nodes and exact
                // serialized-size deltas before mutating any snapshot.
                if self.apply_interaction_transforms(&transforms)?{
                    // Ordinary patches retain only the exact size receipt,
                    // not the stronger whole-install/root-translation gate.
                    if let Some(bytes)=self.source_doc_bytes.take(){
                        self.retained_source_size=Some(RetainedSourceSize::new(self.source_doc.as_ref().unwrap(),bytes));
                    }
                    return Ok(damage)
                }
            }
        }
        // Unknown optical read dependencies still invalidate all paint. A
        // proven translation need not clone the entire authored document just
        // to discover that same conservative certificate.
        if self.source_doc_bytes.is_some() && patch.nodes.len() <= 16 && self.can_retain_translation(patch)
            && crate::dirty_region::has_unbounded_backdrop_for_patch(self.source_doc.as_ref().unwrap(), patch) {
            let transforms = patch.nodes.iter().map(|(id,n)| (id.clone(), n.as_ref().unwrap().transform)).collect();
            if self.apply_interaction_transforms(&transforms)? {
                return Ok(crate::dirty_region::PatchDamage { full:true,reason:Some("glass-effect"),
                    bounds:None,rects:None,translation_only:Some(true) });
            }
        }
        if let Some(damage) = self.apply_clipped_root_translation(patch)? { return Ok(damage); }
        let source = self
            .source_doc
            .as_ref()
            .ok_or("Load document before applying a patch")?;
        let (next, next_bytes) = patch.apply_with_size(source)
            .map_err(|e| e.to_string())?.into_parts();
        let retained_paint = self.retainable_paint_changes(patch);
        let mut damage = if retained_paint.as_ref().is_some_and(Vec::is_empty) {
            // Certify once from resolved placement. The exact material proof
            // preserves geometry, effect support and optical isolation.
            crate::dirty_region::resolved_material_damage(self.doc.as_ref().unwrap(), patch, &self.fonts)
        } else {
            crate::dirty_region::patch_damage_with_fonts(source, &next, patch, &self.fonts)
        };
        if crate::repeat::has_repeats(source) || crate::repeat::has_repeats(&next) {
            damage.full = true; damage.reason = Some("repeat-derived-scene"); damage.bounds = None; damage.rects = None;
        }
        // A proven rigid translation does not change local layout, shaped text,
        // resource identity or path topology. Keep those derived products; only
        // device geometry and the damage-dependent tile programs become dirty.
        if self.can_retain_translation(patch) {
            for (id, node) in &patch.nodes {
                let transform = node.as_ref().expect("validated translation").transform;
                self.doc.as_mut().unwrap().nodes.get_mut(id).unwrap().transform = transform;
                if let Some(base) = &mut self.text_base {
                    if let Some(node) = base.nodes.get_mut(id) { node.transform = transform; }
                }
            }
            self.source_doc = Some(next.into());
            self.source_doc_bytes = None;
            self.retained_source_size = Some(RetainedSourceSize::new(self.source_doc.as_ref().unwrap(), next_bytes));
            self.geo_revision += 1;
            if let Some(cache) = &mut self.camera_prepare {
                cache.translated(self.doc.as_ref().unwrap(), patch.nodes.keys().cloned(), self.geo_revision, &self.render_index.as_ref().unwrap().parents);
            }
            damage.translation_only = Some(true);
        } else if let Some(bounds_dirty) = retained_paint {
            for (id, node) in &patch.nodes {
                let node = node.as_ref().unwrap();
                crate::derived_invalidation::apply_paint(self.doc.as_mut().unwrap().nodes.get_mut(id).unwrap(), node);
                if let Some(base) = &mut self.text_base {
                    if let Some(target) = base.nodes.get_mut(id) { crate::derived_invalidation::apply_paint(target, node); }
                }
            }
            self.source_doc = Some(next.into());
            self.source_doc_bytes = None;
            self.retained_source_size = Some(RetainedSourceSize::new(self.source_doc.as_ref().unwrap(), next_bytes));
            self.geo_revision += 1;
            if let Some(cache) = &mut self.camera_prepare {
                if !bounds_dirty.is_empty() {
                    cache.translated(self.doc.as_ref().unwrap(), bounds_dirty.into_iter(), self.geo_revision, &self.render_index.as_ref().unwrap().parents);
                }
                cache.paint_changed(self.geo_revision,self.doc.as_ref().unwrap(),patch.nodes.keys().cloned(),&self.render_index.as_ref().unwrap().parents);
            }
        } else {
            let retain_index=crate::render_index::RenderIndex::preserved_by(source,patch);
            // apply_with_size already validated and measured these exact values.
            // Storage compaction/sharing during installation changes no JSON.
            self.install_document_policy(next,retain_index,false)?;
            self.source_doc_bytes = Some(next_bytes);
        }
        Ok(damage)
    }
    fn retainable_paint_changes(&self, patch: &crate::editing::DocumentPatch) -> Option<Vec<String>> {
        let source = self.source_doc.as_ref()?;
        if crate::repeat::has_repeats(source) { return None; }
        let resolved = self.doc.as_ref()?;
        let index = self.render_index.as_ref()?;
        if self.layout_dirty || self.animation_base.is_some() || self.animation_sample.is_some()
            || !source.animations.is_empty()
            || !patch.fields.is_empty() || patch.nodes.is_empty() { return None; }
        let mut bounds = Vec::new();
        for (id, next) in &patch.nodes {
            let (old, next) = (source.nodes.get(id)?, next.as_ref()?);
            let derived = resolved.nodes.get(id)?;
            // Shared styles/bindings are rejected below. Font-source metadata
            // elsewhere in a real imported document must not disable this
            // local proof. Check the actual material before retaining it.
            if derived.fills != old.fills || derived.opacity != old.opacity || derived.effects != old.effects
                || derived.strokes != old.strokes { return None; }
            let change = crate::derived_invalidation::paint_change(old, next)?;
            for id in std::iter::once(id.as_str()).chain(index.parents.ancestors(id)) {
                let node = source.nodes.get(id)?;
                if !node.bindings.is_empty() || !node.style_refs.is_empty() || !node.variable_modes.is_empty()
                    || node.component.is_some() || node.component_set || node.instance.is_some()
                    || node.instance_origin.is_some() || node.component_key.is_some()
                    || node.boolean_operation.is_some() { return None; }
            }
            if change == crate::derived_invalidation::PaintChange::Bounds { bounds.push(id.clone()); }
        }
        Some(bounds)
    }
    fn can_retain_translation(&self, patch: &crate::editing::DocumentPatch) -> bool {
        self.can_retain_interaction(patch, false)
    }
    /// Shared interaction-lane validation. `affine` admits linear-part changes
    /// (rotation/scale): the moved subtree's prepared entries and aggregate
    /// ancestor bounds are always rebuilt, so only translation-specific cache
    /// retention (camera metadata) differs, which the caller invalidates.
    fn can_retain_interaction(&self, patch: &crate::editing::DocumentPatch, affine: bool) -> bool {
        let (Some(source), Some(resolved)) = (&self.source_doc, &self.doc) else { return false; };
        if crate::repeat::has_repeats(source) { return false; }
        let Some(index) = &self.render_index else { return false; };
        if self.layout_dirty || self.animation_base.is_some() || self.animation_sample.is_some()
            || !source.animations.is_empty() || !patch.fields.is_empty() || patch.nodes.is_empty()
            || index.has_connectors { return false; }
        let parents = &index.parents;
        patch.nodes.iter().all(|(id, next)| {
            let (Some(old), Some(next), Some(derived)) = (source.nodes.get(id), next, resolved.nodes.get(id)) else { return false; };
            if !affine && old.transform.0[..4] != next.transform.0[..4] || derived.transform != old.transform { return false; }
            let mut translated = old.clone(); translated.transform = next.transform;
            if translated != *next { return false; }
            for id in std::iter::once(id.as_str()).chain(parents.ancestors(id)) {
                let node = &source.nodes[id];
                if !node.bindings.is_empty() || !node.variable_modes.is_empty() || node.component.is_some()
                    || node.component_set || node.instance.is_some() || node.instance_origin.is_some()
                    || node.component_key.is_some() || node.boolean_operation.is_some() { return false; }
                // Descendant local layout survives rigid movement. An ancestor
                // flow/hug layout can reposition siblings and must resolve normally.
                if id != old.id && (node.layout.as_ref().is_some_and(|l| l.mode != crate::layout::Flow::None)
                    || node.sizing.as_ref().is_some_and(|s| s.width == crate::layout::SizeMode::Hug || s.height == crate::layout::SizeMode::Hug)) { return false; }
                let candidate=if id==old.id{next}else{node};let derived=&resolved.nodes[id];
                if candidate.width.to_bits()!=derived.width.to_bits()||candidate.height.to_bits()!=derived.height.to_bits()||
                    (id!=old.id&&candidate.transform.0.iter().zip(derived.transform.0).any(|(a,b)|a.to_bits()!=b.to_bits()))||
                    !crate::layout::pose_constraint_fixed(candidate,parents.ancestors(id).next().and_then(|id|resolved.nodes.get(id)),
                        source.pages.iter().any(|page|page.children.iter().any(|child|child==id))){return false}
            }
            true
        })
    }
    /// Interaction-lane transforms for live pointer poses: keep authoritative
    /// local geometry and recompile device coverage at the new sample phase.
    /// No document-table clone or conservative damage walk is needed; the
    /// settled lane computes damage when the actual edit is committed.
    /// Translations retain every translation-safe cache; affine edits rotate
    /// or scale the moved subtree and additionally rebuild the camera metadata
    /// summary (device-space effect margins can change). Validate all nodes
    /// atomically.
    pub fn apply_interaction_transforms(&mut self, transforms: &std::collections::BTreeMap<String, Transform>) -> Result<bool, String> {
        if transforms.is_empty() || transforms.len() > 16 { return Err("Invalid interaction transform count".into()); }
        let source = self.source_doc.as_ref().ok_or("Load document before interaction")?;
        let affine = transforms.iter().any(|(id, transform)| {
            source.nodes.get(id).map(|old| old.transform.0[..4] != transform.0[..4]).unwrap_or(true)
        });
        let mut nodes = std::collections::BTreeMap::new();
        for (id, transform) in transforms {
            let mut node = source.nodes.get(id).ok_or("Unknown interaction node")?.clone();
            if !transform.0.iter().all(|v| v.is_finite()) { return Err("Non-finite interaction transform".into()); }
            node.transform = *transform;
            nodes.insert(id.clone(), Some(node));
        }
        let patch = crate::editing::DocumentPatch { nodes, fields: Default::default() };
        if !self.can_retain_interaction(&patch, affine) { return Ok(false); }
        source.validate_nodes(patch.nodes.iter().map(|(id,node)| (id,node.as_ref().unwrap())))?;
        // The full apply already counted this exact, still-unchanged source.
        // Capacity is pinned for the process; keep node validation before this
        // point and the final adjusted-size admission below exactly as before.
        // Do not take the receipt until success: rejection must preserve it.
        let mut bytes = match self.source_doc_bytes.or_else(||
            self.retained_source_size.as_ref().and_then(|receipt| receipt.bytes_for(source))) {
            Some(bytes) => bytes,
            None => crate::editing::serialized_document_size(source).map_err(|e| e.to_string())?,
        };
        for (id, next) in &patch.nodes {
            // Only the always-serialized transform changes in this validated
            // lane; every other byte of the node is identical.
            bytes = bytes - crate::editing::serialized_size(&source.nodes[id].transform).map_err(|e| e.to_string())?
                + crate::editing::serialized_size(&next.as_ref().unwrap().transform).map_err(|e| e.to_string())?;
        }
        crate::capacity::check_document_bytes(bytes)?;
        // Pointer-up can repeat the exact last accepted pose. Keep all
        // validation/admission above, but do not detach snapshots, advance
        // geometry lineage or invalidate exact programs for an unchanged
        // authored AND resolved transform. Signed zero remains significant.
        let same = |a: &Transform, b: &Transform| a.0.iter().zip(b.0).all(|(a,b)| a.to_bits()==b.to_bits());
        if transforms.iter().all(|(id,transform)| {
            same(&source.nodes[id].transform,transform) &&
            self.doc.as_ref().and_then(|doc|doc.nodes.get(id)).is_some_and(|n|same(&n.transform,transform)) &&
            self.text_base.as_ref().and_then(|doc|doc.nodes.get(id)).is_none_or(|n|same(&n.transform,transform))
        }) { return Ok(true); }
        // All fallible checks have completed. Release the Weak receipt before
        // mutating so a sole owner need not detach only because of this cache.
        self.retained_source_size = None;
        for (id, transform) in transforms {
            self.source_doc.as_mut().unwrap().nodes.get_mut(id).unwrap().transform = *transform;
            self.doc.as_mut().unwrap().nodes.get_mut(id).unwrap().transform = *transform;
            if let Some(node) = self.text_base.as_mut().and_then(|doc| doc.nodes.get_mut(id)) { node.transform = *transform; }
        }
        self.source_doc_bytes = Some(bytes);
        let previous_revision = self.geo_revision;
        self.geo_revision += 1;
        self.interaction_transform_revision = Some((previous_revision, self.geo_revision, transforms.keys().cloned().collect()));
        let local_support_only = transforms.keys().all(|id| {
            let node = &self.doc.as_ref().unwrap().nodes[id];
            node.children.is_empty() && (!affine || node.effects.iter().all(|effect| !effect.visible))
        });
        if local_support_only && self.source_compile_context.is_none() {
            if let (Some(cache),Some(index))=(&mut self.world_support,&self.render_index) {
                if cache.revision==previous_revision {
                    // A shared snapshot must keep its own exact certificates.
                    // A private cache can conservatively forget moved leaves
                    // without flattening every unrelated path on each input.
                    if let Some(support)=Arc::get_mut(&mut cache.index) {
                        support.invalidate_leaf_transforms(transforms.keys(),&index.parents);
                        cache.revision=self.geo_revision;
                        // Translations preserve halo coefficients. An affine
                        // leaf with no visible effects is absent from
                        // every effect path in MarginIndex, so it cannot change
                        // that index either. Stroke support belongs to the
                        // removed leaf/ancestor certificates and is rebuilt.
                        // PageProperties has no placement
                        // facts; transformed() still refreshes camera metadata.
                    }
                }
            }
        }
        if let Some(cache) = &mut self.camera_prepare {
            if affine {
                cache.transformed(self.doc.as_ref().unwrap(), transforms.keys().cloned(), self.geo_revision, &self.render_index.as_ref().unwrap().parents);
            } else {
                cache.translated(self.doc.as_ref().unwrap(), transforms.keys().cloned(), self.geo_revision, &self.render_index.as_ref().unwrap().parents);
            }
        }
        Ok(true)
    }
    fn apply_clipped_root_translation(&mut self, patch: &crate::editing::DocumentPatch)
        -> Result<Option<crate::dirty_region::PatchDamage>, String> {
        if self.source_doc_bytes.is_none() || !self.can_retain_translation(patch) { return Ok(None); }
        if !patch.nodes.keys().all(|id| self.source_doc.as_ref().unwrap().pages.iter().any(|page| page.children.contains(id))) { return Ok(None); }
        let source = self.source_doc.as_ref().unwrap();
        if !patch.nodes.keys().all(|id| {
            let authored=&source.nodes[id];let resolved=&self.doc.as_ref().unwrap().nodes[id];
            authored.width==resolved.width&&authored.height==resolved.height
        }) { return Ok(None); }
        if !patch.nodes.values().all(|node| node.as_ref().is_some_and(|node|
            node.kind == "frame" && node.clip && !node.mask && node.network.is_none() && node.derived_path.is_none()
                && node.strokes.iter().all(|stroke| !stroke.visible || stroke.width <= 0.)
                && node.effects.iter().all(|effect| !effect.visible || effect.kind == "background-blur"))) {
            return Ok(None);
        }
        // Graph, styles and resources are unchanged by the translation proof.
        // Validate changed nodes with the same schema checks as normal edits,
        // and update the exact serialized-size accounting before any mutation.
        source.validate_nodes(patch.nodes.iter().map(|(id, node)| (id, node.as_ref().unwrap())))?;
        if patch.nodes.values().any(|node| {
            let node = node.as_ref().unwrap();
            [Point::new(0., 0.), Point::new(node.width, 0.), Point::new(node.width, node.height), Point::new(0., node.height)]
                .into_iter().map(|point| node.transform.point(point))
                .any(|point| !point.finite() || point.x.abs() > 16_000_000. || point.y.abs() > 16_000_000.)
        }) { return Ok(None); }
        let mut bytes = self.source_doc_bytes.unwrap();
        for (id, next) in &patch.nodes {
            let old = crate::editing::serialized_size(&source.nodes[id].transform).map_err(|e| e.to_string())?;
            let new = crate::editing::serialized_size(&next.as_ref().unwrap().transform).map_err(|e| e.to_string())?;
            bytes = bytes - old + new;
        }
        crate::capacity::check_document_bytes(bytes)?;
        let rect = |node: &crate::scene::Node| {
            let bounds = Rect::from_points([
                Point::new(0., 0.), Point::new(node.width, 0.),
                Point::new(node.width, node.height), Point::new(0., node.height),
            ].into_iter().map(|point| node.transform.point(point))).expand(2);
            [bounds.x as f64, bounds.y as f64, bounds.w as f64, bounds.h as f64]
        };
        let rects: Vec<_> = patch.nodes.iter().flat_map(|(id, next)|
            [rect(&source.nodes[id]), rect(next.as_ref().unwrap())]).collect();
        self.retained_source_size = None;
        for (id, next) in &patch.nodes {
            let transform = next.as_ref().unwrap().transform;
            self.source_doc.as_mut().unwrap().nodes.get_mut(id).unwrap().transform = transform;
            self.doc.as_mut().unwrap().nodes.get_mut(id).unwrap().transform = transform;
            if let Some(node) = self.text_base.as_mut().and_then(|doc| doc.nodes.get_mut(id)) { node.transform = transform; }
        }
        self.source_doc_bytes = Some(bytes);
        self.geo_revision += 1;
        if let Some(cache) = &mut self.camera_prepare {
            cache.translated(self.doc.as_ref().unwrap(), patch.nodes.keys().cloned(), self.geo_revision, &self.render_index.as_ref().unwrap().parents);
        }
        Ok(Some(crate::dirty_region::clipped_translation_damage(
            self.doc.as_ref().unwrap(), rects, patch.nodes.keys().cloned().collect(), &self.fonts)))
    }
    fn install_document(&mut self, doc: impl Into<Document>) -> Result<(), String> {
        self.install_document_with_index(doc.into(),false)
    }
    fn install_document_with_index(&mut self,doc:Document,retain_index:bool)->Result<(),String>{
        self.install_document_policy(doc,retain_index,true)
    }
    fn install_document_policy(&mut self,mut doc:Document,retain_index:bool,measure_size:bool)->Result<(),String>{
        doc.validate()?;
        // Preserve exact authored strings while sharing identical immutable
        // payload allocations. Derived snapshots and packet preparation can
        // then recognize a retained image without copying/hash-scanning it at
        // every camera. This changes no serialized value or resource grant.
        let mut image_owners=std::collections::HashMap::<std::sync::Arc<str>,std::sync::Arc<str>>::new();
        for n in doc.nodes.values_mut(){n.compact_storage();for paint in n.fills.iter_mut().chain(n.strokes.iter_mut().map(|s|&mut s.paint)){
            if let Some(uri)=&mut paint.image {
                *uri=image_owners.entry(uri.clone()).or_insert_with(||uri.clone()).clone();
            }
        }}
        let fonts = self.fonts.with_resources(&doc.fonts)?;
        let previous = self.doc.as_ref().filter(|old| !self.layout_dirty && self.animation_sample.is_none()
            && old.id==doc.id && old.pages==doc.pages && old.fonts==doc.fonts
            && old.color_management==doc.color_management && old.raster_profile==doc.raster_profile
            && old.animations.is_empty() && doc.animations.is_empty()).cloned();
        let resolved_source=self.source_doc.as_ref().zip(self.doc.as_ref()).is_some_and(|(source,resolved)|source==resolved);
        self.pending_layout = resolved_source.then(|| previous.clone()).flatten();
        self.pending_camera = previous.zip(self.camera_prepare.take()).map(|(doc,cache)|(doc,cache,resolved_source));
        self.images.set_color_settings(doc.color_management);
        self.images.retain_document(&doc);
        if self.doc.as_ref().is_some_and(|old| old.fonts != doc.fonts) {
            self.paths.clear();
        }
        self.paths.retain(|id, _| {
            self.doc
                .as_ref()
                .and_then(|old| old.nodes.get(id))
                .zip(doc.nodes.get(id))
                .is_some_and(|(old, new)| old.same_geometry(new))
        });
        self.text_base = None;
        // Loading historically admits by input size; oversized normalized
        // documents keep that behaviour, but cannot take the local fast path.
        self.source_doc_bytes = if measure_size {crate::editing::serialized_document_size(&doc).ok()} else {None};
        self.retained_source_size = None;
        if !retain_index||self.render_index.is_none(){
            self.render_index = Some(Arc::new(crate::render_index::RenderIndex::new(&doc)));
        }
        let doc = SharedDocument::from(doc);
        self.source_doc = Some(doc.clone());
        self.doc = Some(doc);
        self.fonts = fonts;
        self.animation_base = None;
        self.animation_sample = None;
        self.layout_dirty = true;
        self.geo_revision += 1;
        self.camera_prepare = None;
        self.camera_residency.clear();
        self.world_support = None;
        self.source_compile_context = None;
        Ok(())
    }
    pub fn stats(&self) -> &Stats {
        &self.stats
    }
    /// The compositing ledger in Figma's shape: two pools —
    /// scene-compositing peak and tile residency —
    /// summed, `>> 20` for MB, f32 tile ratio, plus OOM-style pressure
    /// events from budget rejections. Diagnostic only; admission stays the
    /// reserve/Drop contract.
    /// Test seam: resident linear-tile count of the interactive tier cache.
    pub fn linear_tile_cache_len(&self) -> usize {
        self.linear_tiles.len()
    }
    pub fn compositing_ledger(&self) -> CompositingLedger {
        let tile_bytes = self
            .tiled
            .as_ref()
            .map_or(0, crate::tiled_renderer::TiledRenderer::resident_bytes);
        let total_bytes = self.scene_peak_bytes.saturating_add(tile_bytes);
        CompositingLedger {
            scene_peak_bytes: self.scene_peak_bytes,
            tile_resident_bytes: tile_bytes,
            rendered_tile_vram_mb: (tile_bytes >> 20) as u32,
            total_vram_mb: (total_bytes >> 20) as u32,
            tile_vram_ratio: if total_bytes > 0 {
                (tile_bytes as f32) / (total_bytes as f32)
            } else {
                0.
            },
            budget_rejections: self.budget_rejections,
            last_rejection: self.last_rejection.map(|r| RejectionInfo {
                requested_bytes: r.0,
                live_bytes: r.1,
            }),
        }
    }
    /// The shared GPU memory ledger handle. A host that owns the allocating
    /// device installs this same instance there (`NativeGpu::
    /// set_memory_ledger`) before the first compose; clones share one state,
    /// so the export below always reports allocation-side facts.
    pub fn gpu_memory_ledger(&self) -> crate::memory::GpuMemoryLedger {
        self.gpu_memory.clone()
    }
    /// Four-bucket GPU memory breakdown plus peaks, `needs_free` pressure
    /// flag and the five Figma telemetry axes
    /// (`getRendererMemoryBreakdown`/`getRendererGpuMemory` shape).
    pub fn gpu_memory_breakdown(&self) -> GpuMemoryBreakdown {
        let usage = self.gpu_memory.usage();
        GpuMemoryBreakdown {
            texture_bytes: usage.texture_bytes,
            buffer_bytes: usage.buffer_bytes,
            fixed_array_bytes: usage.fixed_array_bytes,
            blob_bytes: usage.blob_bytes,
            peak_texture_bytes: usage.peak_texture_bytes,
            peak_buffer_bytes: usage.peak_buffer_bytes,
            peak_fixed_array_bytes: usage.peak_fixed_array_bytes,
            peak_blob_bytes: usage.peak_blob_bytes,
            peak_total_bytes: usage.peak_total_bytes,
            total_bytes: usage.total_bytes(),
            limit_bytes: self.gpu_memory.limit_bytes(),
            needs_free: self.gpu_memory.needs_free(),
            free_events: usage.free_events,
            rejections: usage.rejections,
            figma_axes: crate::render_telemetry::FigmaGpuMemoryAxes::from(&usage),
        }
    }
    pub fn parse_options(&self, mut value: serde_json::Value) -> Result<RenderOptions, String> {
        let fields = value
            .as_object_mut()
            .ok_or("Render options must be an object")?;
        if !fields.contains_key("rasterProfile") {
            let profile = self
                .source_doc
                .as_ref()
                .and_then(|d| d.raster_profile)
                .unwrap_or(if self.color_settings().is_some() {
                    crate::fidelity::RasterProfile::Figma
                } else {
                    crate::fidelity::RasterProfile::Analytic
                });
            fields.insert(
                "rasterProfile".into(),
                serde_json::to_value(profile).map_err(|e| e.to_string())?,
            );
        }
        serde_json::from_value(value).map_err(|e| e.to_string())
    }
    pub(crate) fn prepare_frame(&mut self, options: &RenderOptions) -> Result<(), String> {
        if let Some(request) = &options.animation {
            let base = self
                .animation_base
                .as_ref()
                .or(self.doc.as_ref())
                .ok_or("Load document first")?;
            let clip = base
                .animations
                .iter()
                .find(|c| c.id == request.clip_id)
                .ok_or("Animation clip not found")?;
            if clip.page_id != options.page_id {
                return Err("Animation clip belongs to another page".into());
            }
        }
        self.prepare_animation(options.animation.as_ref())
    }
    pub(crate) fn prepare_animation(
        &mut self,
        request: Option<&crate::animation::Sample>,
    ) -> Result<(), String> {
        if self.animation_sample.as_ref() == request {
            return Ok(());
        }
        if let Some(request) = request {
            let candidate = if self.animation_base.is_none() {
                self.resolve_layout()?;
                if self.source_doc.as_ref().is_some_and(|d| crate::repeat::has_repeats(d)) {
                    // Sample editable sources first, then regenerate every appearance.
                    let mut base = self.source_doc.as_ref().unwrap().clone();
                    crate::design_system::resolve_authored(&mut base)?;
                    crate::components::resolve(&mut base)?;
                    crate::layout::resolve(&mut base, &self.fonts)?;
                    crate::curve_boolean::resolve(&mut base)?;
                    Some(base)
                } else {
                    Some(self.text_base.as_ref().or(self.doc.as_ref()).ok_or("Load document first")?.clone())
                }
            } else {
                None
            };
            let (mut sampled, _) = crate::animation::sample_validated(
                self.animation_base.as_ref().or(candidate.as_ref()).unwrap(),
                request,
            )?;
            if self.animation_base.is_none() {
                self.animation_base = candidate;
            }
            self.paths.retain(|id, _| {
                self.doc
                    .as_ref()
                    .and_then(|d| d.nodes.get(id))
                    .zip(sampled.nodes.get(id))
                    .is_some_and(|(a, b)| a.same_geometry(b))
            });
            crate::curve_boolean::resolve(&mut sampled)?;
            crate::repeat::resolve(&mut sampled)?;
            crate::font::expand_rich_text(&mut sampled, &self.fonts)?;
            self.doc = Some(sampled.into());
            // Sample resolved layout geometry. Timeline recording captures the
            // selected subtree, so auto-layout does not overwrite interpolated poses.
            self.layout_dirty = false;
            self.animation_sample = Some(request.clone());
        } else if let Some(mut base) = self.animation_base.take() {
            self.paths.retain(|id, _| {
                self.doc
                    .as_ref()
                    .and_then(|d| d.nodes.get(id))
                    .zip(base.nodes.get(id))
                    .is_some_and(|(a, b)| a.same_geometry(b))
            });
            crate::repeat::resolve(&mut base)?;
            crate::font::expand_rich_text(&mut base, &self.fonts)?;
            self.doc = Some(base);
            self.animation_sample = None;
            self.layout_dirty = false;
        }
        Ok(())
    }
    fn restore_resolved_camera(&mut self) {
        let Some((before,mut cache,_))=self.pending_camera.take() else{return};
        let Some(after)=self.doc.as_ref() else{return};
        // Reparenting, generated-node insertion/removal and order changes need
        // the old full rebuild. Never infer unchanged topology from a patch hint.
        if before.nodes.len()!=after.nodes.len() || before.nodes.iter().any(|(id,n)|
            after.nodes.get(id).is_none_or(|next|n.children!=next.children)) {return;}
        let changed=after.nodes.iter().filter(|(id,n)|before.nodes.get(*id)!=Some(*n)).map(|(id,_)|id.clone()).collect::<Vec<_>>();
        let parents=crate::render_index::Parents::new(after);
        cache.transformed(after,changed.into_iter(),self.geo_revision,&parents);
        self.camera_prepare=Some(cache);
    }
    pub(crate) fn resolve_layout(&mut self) -> Result<(), String> {
        if !self.layout_dirty {
            return Ok(());
        }
        let scope=match (&self.pending_layout,&self.doc){
            (Some(before),Some(after))=>crate::component_updates::plan(before,after)?, _=>None,
        };
        if let Some(doc) = &mut self.doc {
            if !doc
                .nodes
                .values()
                .any(|n| n.layout.is_some() || n.sizing.is_some() || n.constraints.is_some())
                && !crate::repeat::has_repeats(doc)
                && !crate::components::has_components(doc)
                && doc.design_system.is_none()
                && !doc
                    .nodes
                    .values()
                    .any(|n| n.boolean_operation.is_some() || !n.text_runs.is_empty())
            {
                self.layout_dirty = false;
                self.pending_layout = None;
                self.restore_resolved_camera();
                return Ok(());
            }
            let before = doc.clone();
            let resolved=if let Some(scope)=&scope{
                crate::component_updates::resolve_plan(doc,&self.fonts,scope)
            }else{
                crate::design_system::resolve_authored(doc)
                .and_then(|()| crate::components::resolve(doc))
                .and_then(|()| crate::layout::resolve(doc, &self.fonts))
                .and_then(|()| crate::curve_boolean::resolve(doc))
                .and_then(|()| crate::components::check_budget(doc))
                .and_then(|()| doc.validate())
            };
            if let Err(error) = resolved.and_then(|()| crate::repeat::resolve(doc))
                .and_then(|()| {
                    self.text_base = doc
                        .nodes
                        .values()
                        .any(|n| {
                            n.text_runs
                                .iter()
                                .any(|r| r.color.is_some() || r.underline || r.strikethrough)
                        })
                        .then(|| doc.clone());
                    crate::font::expand_rich_text(doc, &self.fonts)
                })
            {
                *doc = before;
                return Err(error);
            }
            self.paths.retain(|id, _| {
                before
                    .nodes
                    .get(id)
                    .zip(doc.nodes.get(id))
                    .is_some_and(|(a, b)| a.same_geometry(b))
            });
        }
        self.layout_dirty = false;
        self.pending_layout = None;
        self.restore_resolved_camera();
        Ok(())
    }
    pub fn render(&mut self, options: &RenderOptions) -> Result<Vec<u8>, String> {
        if self
            .doc
            .as_ref()
            .is_some_and(|d| d.color_management.is_some())
        {
            let settings = self
                .doc
                .as_ref()
                .and_then(|d| d.color_management)
                .ok_or("Missing color settings")?;
            let linear = if options.interactive_effects {
                self.render_managed_interactive(options)?
            } else {
                self.render_linear(options)?
            };
            let transform = settings.prepare_output(Default::default());
            return Ok(linear
                .into_iter()
                .flat_map(|p| {
                    transform.apply(p)
                        .map(|v| (v.clamp(0., 1.) * 255.).round_ties_even() as u8)
                })
                .collect());
        }
        self.prepare_frame(options)?;
        self.resolve_layout()?;
        if options.pixel_preview.is_some() {
            let plan = crate::preview::plan(options)?;
            let source = self.render(&plan.source)?;
            return Ok(crate::preview::resample(&source, &plan));
        }
        if matches!(
            options.raster_profile,
            crate::fidelity::RasterProfile::Figma
                | crate::fidelity::RasterProfile::FigmaSubpixel
                | crate::fidelity::RasterProfile::FigmaSoftware
        ) {
            if options.width == 0
                || options.height == 0
                || options.width > 8192
                || options.height > 8192
                || u64::from(options.width) * u64::from(options.height) > 8_388_608
            {
                return Err("Invalid Figma render size".into());
            }
            let coherent = self
                .doc
                .as_ref()
                .is_some_and(|doc| crate::fidelity::coherent_samples(doc, options));
            let mut frame_stats = Stats::default();
            let mut result = vec![0; options.width as usize * options.height as usize * 4];
            // Bound source tiles, not only output tiles: Figma renders at 2x.
            // A 512px output tile otherwise allocates 1024px sample planes,
            // exhausting the unchanged 256 MiB budget for a simple glass layer.
            let tile_side = if options.raster_profile.is_export() {
                256
            } else {
                512
            };
            for y in (0..options.height).step_by(tile_side as usize) {
                for x in (0..options.width).step_by(tile_side as usize) {
                    let w = (options.width - x).min(tile_side);
                    let h = (options.height - y).min(tile_side);
                    let tile = self.export_tile(options, coherent, x, y, w, h)?;
                    frame_stats.accumulate(&self.stats);
                    for row in 0..h as usize {
                        let dst = ((y as usize + row) * options.width as usize + x as usize) * 4;
                        result[dst..dst + w as usize * 4].copy_from_slice(
                            &tile[row * w as usize * 4..(row + 1) * w as usize * 4],
                        );
                    }
                }
            }
            self.stats = frame_stats;
            return Ok(result);
        }
        self.render_scene(options)
    }
    fn render_scene(&mut self, options: &RenderOptions) -> Result<Vec<u8>, String> {
        Ok(self.render_scene_inner(options, false)?.remove(0))
    }
    fn render_scene_inner(
        &mut self,
        options: &RenderOptions,
        synchronized: bool,
    ) -> Result<Vec<Vec<u8>>, String> {
        self.render_scene_inner_at(
            options,
            synchronized,
            Rect::new(0, 0, options.width, options.height),
            0,
        )
    }
    fn render_scene_inner_at(
        &mut self,
        options: &RenderOptions,
        synchronized: bool,
        viewport: Rect,
        extra_halo: i32,
    ) -> Result<Vec<Vec<u8>>, String> {
        Ok(self
            .render_surfaces_at(options, synchronized, viewport, extra_halo)?
            .iter()
            .map(|s| s.rgba8(viewport))
            .collect())
    }
    fn render_surfaces_at(
        &mut self,
        options: &RenderOptions,
        synchronized: bool,
        viewport: Rect,
        extra_halo: i32,
    ) -> Result<Vec<Surface>, String> {
        self.render_surfaces_with_budget(
            options,
            synchronized,
            viewport,
            extra_halo,
            Budget::new(COMPOSITING_BYTES),
        )
    }
    fn render_surfaces_with_budget(
        &mut self,
        options: &RenderOptions,
        synchronized: bool,
        viewport: Rect,
        extra_halo: i32,
        budget: Budget,
    ) -> Result<Vec<Surface>, String> {
        // The ledger clone shares the budget's usage Arc, so pressure events
        // stay observable even when the render below fails and returns early.
        let ledger_budget = budget.clone();
        let result =
            self.render_surfaces_with_budget_inner(options, synchronized, viewport, extra_halo, budget);
        let ledger_usage = ledger_budget.usage();
        self.scene_peak_bytes = self.scene_peak_bytes.max(ledger_usage.peak_bytes);
        self.budget_rejections += ledger_usage.rejections;
        if ledger_usage.rejections > 0 {
            self.last_rejection = Some((
                ledger_usage.last_rejection_requested_bytes,
                ledger_usage.last_rejection_live_bytes,
            ));
        }
        result
    }
    fn render_surfaces_with_budget_inner(
        &mut self,
        options: &RenderOptions,
        synchronized: bool,
        viewport: Rect,
        extra_halo: i32,
        budget: Budget,
    ) -> Result<Vec<Surface>, String> {
        self.render_surfaces_regions(options, synchronized, viewport, extra_halo, budget, true)
    }
    fn render_surfaces_regions(
        &mut self, options: &RenderOptions, synchronized: bool, viewport: Rect,
        extra_halo: i32, budget: Budget, regional: bool,
    ) -> Result<Vec<Surface>, String> {
        let coverage_compatible =
            options.raster_profile != crate::fidelity::RasterProfile::Analytic;
        let compatible = coverage_compatible
            && self
                .doc
                .as_ref()
                .is_none_or(|d| d.color_management.is_none());
        self.resolve_layout()?;
        if options.width == 0
            || options.height == 0
            || options.width > 8192
            || options.height > 8192
            || options.width as u64 * options.height as u64 > 8_388_608
            || ![options.view.x, options.view.y, options.view.zoom]
                .into_iter()
                .all(f64::is_finite)
            || !(0.001..=MAX_CANVAS_SAMPLE_SCALE).contains(&options.view.zoom)
        {
            return Err("Invalid render size or view".into());
        }
        let doc = self
            .doc
            .as_ref()
            .ok_or("Load a document before rendering")?;
        let page = doc
            .pages
            .iter()
            .find(|p| p.id == options.page_id)
            .ok_or("Page not found")?;
        let camera = Transform([
            options.view.zoom,
            0.,
            0.,
            options.view.zoom,
            options.view.x,
            options.view.y,
        ]);
        let mut prepared = HashMap::new();
        self.stats = Stats::default();
        fn scene_halo(doc: &Document, id: &str, parent: Transform) -> i32 {
            let n = &doc.nodes[id];
            if !n.visible {
                return 0;
            }
            let m = parent.concat(n.transform);
            effect_halo(n, m).saturating_add(
                n.children
                    .iter()
                    .map(|id| scene_halo(doc, id, m))
                    .max()
                    .unwrap_or(0),
            )
        }
        let guard = viewport.expand(
            extra_halo
                + page
                    .children
                    .iter()
                    .map(|id| scene_halo(doc, id, camera))
                    .max()
                    .unwrap_or(0)
                    .min(2048),
        );
        let zoom_guard=crate::zoom_support::scene_guard(doc,&page.children,camera,viewport.expand(extra_halo),&self.fonts)?;
        let guard=zoom_guard.map_or(guard,|z|guard.union(z));
        for root in &page.children {
            prepare_node_geometry(
                root,
                camera,
                (doc, &self.fonts, guard, coverage_compatible),
                &mut self.paths,
                &mut self.local_strokes,
                &mut prepared,
                &mut self.stats.path_segments,
            )?;
        }
        // Expand before clipping so offscreen content can contribute to filters.
        let max_halo = prepared
            .values()
            .filter(|p| !p.bounds.intersect(viewport).empty())
            .map(|p| p.halo)
            .max()
            .unwrap_or(0);
        if zoom_guard.is_none() && max_halo + extra_halo > 2048 {
            return Err("Combined filter dependency halo exceeds 2048 device pixels".into());
        }
        let extent=zoom_guard.unwrap_or_else(||viewport.expand(max_halo+extra_halo));
        if zoom_guard.is_some() && [viewport.x-extent.x,viewport.y-extent.y,extent.right()-viewport.right(),extent.bottom()-viewport.bottom()].into_iter().max().unwrap_or(0)>2048 {
            return Err("Combined zoom source dependency halo exceeds 2048 device pixels".into());
        }
        let mut target = Surface::new_in(extent, &budget)?;
        let background = if options.transparent {
            Pixel::default()
        } else {
            crate::color::pixel(doc.color_management, &page.background, 1.)?
        };
        target.pixels.fill(background);
        // Figma renders canvas chrome in the engine (its checkerboardStyle
        // shader family); this is the kernel tier of that contract —
        // screen-anchored 16px cells in the CSS tier's colors, painted under
        // content and skipped for transparent exports.
        if options.checkerboard && !options.transparent {
            let alt = crate::color::pixel(doc.color_management, "#eeeeee", 1.)?;
            let cell = if options.raster_profile.is_export() { 32 } else { 16 };
            // Row-level optimization: precompute y.div_euclid(cell) once per row
            for y in extent.y..extent.bottom() {
                let y_cell = y.div_euclid(cell);
                for x in extent.x..extent.right() {
                    // Inner loop only needs x.div_euclid(cell), saves ~50% divisions
                    if ((x.div_euclid(cell) ^ y_cell) & 1) == 0 {
                        continue;
                    }
                    let i = extent.index(x, y).expect("checker");
                    target.pixels[i] = alt;
                }
            }
        }
        if options.grid && !options.transparent && options.view.zoom > 0.13 {
            let spacing = 32. * options.view.zoom;
            // Row-level optimization: precompute dy and dy_sq once per row
            for y in extent.y..extent.bottom() {
                let dy = (y as f64 + 0.5 - options.view.y)
                    .rem_euclid(spacing)
                    .min((options.view.y - y as f64 - 0.5).rem_euclid(spacing));
                if dy > 1. {
                    continue;
                }
                let dy_sq = dy * dy; // Precompute for sqrt in inner loop
                for x in extent.x..extent.right() {
                    let dx = (x as f64 + 0.5 - options.view.x)
                        .rem_euclid(spacing)
                        .min((options.view.x - x as f64 - 0.5).rem_euclid(spacing));
                    // Use sqrt(dx^2 + dy^2) instead of hypot for better performance
                    let coverage = (1. - (dx * dx + dy_sq).sqrt()).clamp(0., 1.) as f32;
                    if coverage > 0. {
                        let i = extent.index(x, y).expect("grid");
                        target.pixels[i] = over(
                            background,
                            Pixel::rgba(0.65, 0.67, 0.73, coverage * 0.4),
                            "normal",
                        );
                    }
                }
            }
        }
        let mut painter = Painter {
            doc,
            prepared: &prepared,
            images: &mut self.images,
            stats: &mut self.stats,
            budget,
            extent,
            viewport,
            compatible,
            coverage_compatible,
            profile: options.raster_profile,
            interactive_effects: options.interactive_effects,
            sample: None,
            raster_workspace: RasterWorkspace::default(),
        };
        let rendered = if synchronized {
            let mut targets = vec![target];
            for _ in 1..4 {
                let mut next = painter.allocate(extent)?;
                next.pixels.clone_from_slice(&targets[0].pixels);
                targets.push(next);
            }
            let mut targets: [Surface; 4] =
                targets.try_into().map_err(|_| "Invalid target samples")?;
            for root in &page.children {
                painter.node_bundle(root, &mut targets, None)?;
            }
            Ok(targets.into_iter().collect())
        } else {
            // Reverse paint order: earlier layers must retain every input read
            // by later backdrop consumers, not merely their own visible output.
            let mut needed = viewport;
            let mut outputs = Vec::with_capacity(page.children.len());
            for root in page.children.iter().rev() {
                let output = if regional && painter.bounded_node(root) { needed } else { extent };
                if regional { needed = needed.union(painter.leaf_backdrop_input(root, output)?); }
                outputs.push(output);
            }
            for (root, output) in page.children.iter().zip(outputs.into_iter().rev()) {
                painter.node_region(root, &mut target, None, regional.then_some(output), extent, false)?;
            }
            Ok(vec![target])
        };
        rendered
    }

    /// Normal display preserves full sampling and effects, including under
    /// compositing pressure. Resource errors are surfaced, never converted
    /// into an implicit single-plane or reduced-effect frame.
    fn render_managed_interactive(&mut self, options: &RenderOptions) -> Result<Vec<Pixel>, String> {
        let mut exact = options.clone();
        exact.interactive_effects = false;
        self.render_linear(&exact)
    }

    /// Explicit reference/reuse API. Normal display never selects this as an
    /// allocation-error fallback. The caller's requested raster/effect tier is
    /// retained; only exact-aligned cameras reuse cached pixels.
    pub fn render_linear_reused(&mut self, options: &RenderOptions) -> Result<Vec<Pixel>, String> {
        // Resampling a previously rasterised tile changes edge coverage. Keep
        // fractional cameras, animation, preview and screen-anchored chrome on
        // the exact path instead of silently lowering their fidelity.
        if options.pixel_preview.is_some()
            || options.animation.is_some()
            || self.animation_sample.is_some()
            || options.checkerboard
            || options.view.x.fract() != 0.
            || options.view.y.fract() != 0.
            || options.view.zoom != crate::tile_stack::exact_bucket_scale(options.view.zoom)
        {
            return self.render_linear(options);
        }
        self.prepare_frame(options)?;
        self.resolve_layout()?;
        if self.color_settings().is_none() {
            return Err("Float rendering requires document color management".into());
        }
        if options.width == 0
            || options.height == 0
            || options.width > 8192
            || options.height > 8192
            || u64::from(options.width) * u64::from(options.height) > 8_388_608
        {
            return Err(format!(
                "Float frame exceeds 8192 per side / 8 million pixels (got {}x{})", options.width, options.height
            ));
        }
        let instruction = self.render_instruction_for(options)?;
        let level = instruction.level_scale;
        let zoom = options.view.zoom;
        let width = options.width as usize;
        let height = options.height as usize;
        let revision = self.geo_revision;
        // Page and colour identity matter even when content revision is equal.
        let identity = (
            instruction.page_id.clone(),
            instruction.options.clone(),
            instruction.color_space.clone(),
        );
        if self.linear_tiles_options.as_ref() != Some(&identity) {
            self.linear_tiles.clear();
            self.linear_tiles_order.clear();
            self.linear_tiles_options = Some(identity);
        }
        let side = 512usize;
        let level_index = crate::tiled_renderer::level_index_for_scale(level);
        let tile_world = f64::from(side as u32) / level;
        let addresses = crate::tile_stack::raster_addresses(
            instruction.viewport,
            level,
            crate::tile_level::LEVEL_TILE_LIMIT,
            [0., 0.],
        )?;
        let mut out = vec![Pixel::default(); width * height];
        for address in addresses {
            let key = (level_index, address);
            let cached = self
                .linear_tiles
                .get(&key)
                .filter(|(rev, _)| *rev == revision)
                .map(|(_, pixels)| Arc::clone(pixels));
            let pixels = if let Some(pixels) = cached {
                pixels
            } else {
                let mut tile_options = options.clone();
                tile_options.view = View {
                    x: -(address[0] as f64) * tile_world * level,
                    y: -(address[1] as f64) * tile_world * level,
                    zoom: level,
                };
                tile_options.width = side as u32;
                tile_options.height = side as u32;
                let pixels = Arc::new(self.linear_rect_pixels(&tile_options, 0, 0, side as u32, side as u32)?);
                self.linear_tiles.insert(key, (revision, Arc::clone(&pixels)));
                pixels
            };
            // One LRU record per key, including a tile rebuilt at a new
            // revision. An old duplicate must not evict its replacement.
            self.linear_tiles_order.retain(|old| *old != key);
            self.linear_tiles_order.push(key);
            let wx = address[0] as f64 * tile_world;
            let wy = address[1] as f64 * tile_world;
            let dx0 = wx * zoom + options.view.x;
            let dy0 = wy * zoom + options.view.y;
            let dx = dx0.round() as i64;
            let dy = dy0.round() as i64;
            let x0 = dx.clamp(0, width as i64) as usize;
            let y0 = dy.clamp(0, height as i64) as usize;
            let x1 = (dx + side as i64).clamp(x0 as i64, width as i64) as usize;
            let y1 = (dy + side as i64).clamp(y0 as i64, height as i64) as usize;
            for row in y0..y1 {
                let src = ((row as i64 - dy) as usize) * side + (x0 as i64 - dx) as usize;
                let dst = row * width + x0;
                let span = x1 - x0;
                out[dst..dst + span].copy_from_slice(&pixels[src..src + span]);
            }
            // Assemble before eviction: a viewport can contain more than the
            // retained 24 tiles and must still present every visible pixel.
            while self.linear_tiles_order.len() > 24 {
                let evict = self.linear_tiles_order.remove(0);
                self.linear_tiles.remove(&evict);
            }
        }
        Ok(out)
    }

    pub fn render_linear(&mut self, options: &RenderOptions) -> Result<Vec<Pixel>, String> {
        self.prepare_frame(options)?;
        if self.doc.as_ref().and_then(|d| d.color_management).is_none() {
            return Err("Float rendering requires document color management".into());
        }
        if options.pixel_preview.is_some() {
            let plan = crate::preview::plan(options)?;
            let source = self.render_linear(&plan.source)?;
            return Ok(crate::preview::resample_linear(&source, &plan));
        }
        if options.width == 0
            || options.height == 0
            || options.width > 8192
            || options.height > 8192
            || u64::from(options.width) * u64::from(options.height) > 8_388_608
        {
            return Err(format!(
                "Float frame exceeds 8192 per side / 8 million pixels (got {}x{})", options.width, options.height
            ));
        }
        let density = if options.raster_profile.is_export() {
            2
        } else {
            1
        };
        let mut pixels = vec![Pixel::default(); options.width as usize * options.height as usize];
        let mut stats = Stats::default();
        let tile_side = 512 / density;
        for y in (0..options.height).step_by(tile_side as usize) {
            for x in (0..options.width).step_by(tile_side as usize) {
                let w = (options.width - x).min(tile_side);
                let h = (options.height - y).min(tile_side);
                let rect = self.linear_rect_pixels(options, x, y, w, h)?;
                stats.accumulate(&self.stats);
                for (row, chunk) in rect.chunks(w as usize).enumerate() {
                    let start = (y as usize + row) * options.width as usize + x as usize;
                    pixels[start..start + w as usize].copy_from_slice(chunk);
                }
            }
        }
        self.stats = stats;

        Ok(pixels)
    }

    /// The linear f32 pixels of one device-pixel rectangle — the shared
    /// per-rect body of [`Self::render_linear`] and, encoded through the
    /// document settings, of [`Self::render_device_rect`] on managed
    /// documents, so tile bytes and full-frame bytes derive from the same
    /// math by construction.
    fn linear_rect_pixels(
        &mut self,
        options: &RenderOptions,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<Vec<Pixel>, String> {
        let density = if options.raster_profile.is_export() { 2 } else { 1 };
        let extra = crate::export::backdrop_padding(
            self,
            options,
            Rect::new(x as i32, y as i32, w, h),
        )?;
        let source = if density == 2 {
            crate::fidelity::source(options, 0, 0, w, h)?
        } else {
            let mut source = options.clone();
            source.width = w;
            source.height = h;
            source
        };
        let viewport = Rect::new(
            (x * density) as i32,
            (y * density) as i32,
            w * density,
            h * density,
        );
        let coherent = crate::fidelity::coherent_samples(
                self.doc.as_ref().unwrap_or_else(|| panic!("document loaded")),
                options,
            );
        let surfaces = self.render_surfaces_at(&source, coherent, viewport, extra * density as i32)?;
        let mut pixels = Vec::with_capacity((w * h) as usize);
        for ty in y..y + h {
            for tx in x..x + w {
                let sx = (tx * density) as i32;
                let sy = (ty * density) as i32;
                let mut value = [0.; 4];
                for surface in &surfaces {
                    for yy in 0..density as i32 {
                        for xx in 0..density as i32 {
                            let p = surface.at(sx + xx, sy + yy);
                            for (c, value) in value.iter_mut().enumerate() {
                                *value += p.0[c]
                                    / (surfaces.len() as u32 * density * density) as f32;
                            }
                        }
                    }
                }
                let p = Pixel(value);
                if p.0.iter().any(|v| !v.is_finite() || v.abs() > 65504.) {
                    return Err("Rendered color exceeds finite float16 range".into());
                }
                pixels.push(p);
            }
        }
        Ok(pixels)
    }

    pub fn render_png(&mut self, options: &RenderOptions) -> Result<Vec<u8>, String> {
        self.prepare_frame(options)?;
        crate::export::render_png(self, options)
    }
    /// Render one device-pixel rectangle of the current page — the CPU
    /// counterpart of the GPU cropped compile. Dirty-region renderers use it
    /// to repaint only affected tiles; the bytes equal the same rectangle of
    /// a full [`Self::render`] because full renders are themselves stitched
    /// from these tiles.
    pub fn render_device_rect(
        &mut self,
        options: &RenderOptions,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<Vec<u8>, String> {
        self.prepare_frame(options)?;
        self.resolve_layout()?;
        if options.pixel_preview.is_some() {
            return Err("Pixel preview presents a resampled frame".into());
        }
        if x >= options.width || y >= options.height {
            return Err("Tile origin outside viewport".into());
        }
        let w = w.min(options.width - x);
        let h = h.min(options.height - y);
        if w == 0 || h == 0 {
            return Ok(Vec::new());
        }
        // Managed documents render through the linear pipeline and encode
        // with the document settings — the same pixels [`Self::render`]
        // produces, so tile residency and full frames stay byte-identical.
        if let Some(settings) = self.color_settings() {
            let pixels = self.linear_rect_pixels(options, x, y, w, h)?;
            let transform = settings.prepare_output(Default::default());
            return Ok(pixels
                .into_iter()
                .flat_map(|p| {
                    transform.apply(p)
                        .map(|v| (v.clamp(0., 1.) * 255.).round_ties_even() as u8)
                })
                .collect());
        }
        let coherent = self
            .doc
            .as_ref()
            .is_some_and(|doc| crate::fidelity::coherent_samples(doc, options));
        self.export_tile(options, coherent, x, y, w, h)
    }
    pub fn render_color_png(
        &mut self,
        options: &RenderOptions,
        output: crate::color::ColorOutput,
    ) -> Result<Vec<u8>, String> {
        let settings = self
            .doc
            .as_ref()
            .and_then(|d| d.color_management)
            .ok_or("Color export requires a managed document")?;
        let pixels = self.render_linear(options)?;
        crate::export::encode_color_png(options.width, options.height, &pixels, settings, output)
    }
    pub(crate) fn export_tile(
        &mut self,
        options: &RenderOptions,
        coherent: bool,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<Vec<u8>, String> {
        let extra_halo =
            crate::export::backdrop_padding(self, options, Rect::new(x as i32, y as i32, w, h))?;
        if options.raster_profile.is_export() {
            let source = crate::fidelity::source(options, 0, 0, w, h)?;
            let viewport = Rect::new((x * 2) as i32, (y * 2) as i32, w * 2, h * 2);
            if coherent {
                let planes = self.render_scene_inner_at(&source, true, viewport, extra_halo * 2)?;
                let resolve = if options.raster_profile.is_software() {
                    crate::fidelity::resolve_software_sample_planes_2x
                } else {
                    crate::fidelity::resolve_sample_planes_2x
                };
                Ok(resolve(
                    [&planes[0], &planes[1], &planes[2], &planes[3]],
                    w,
                    h,
                ))
            } else {
                let source = self
                    .render_scene_inner_at(&source, false, viewport, extra_halo * 2)?
                    .remove(0);
                Ok(crate::fidelity::downsample(&source, w, h))
            }
        } else {
            let mut tile = options.clone();
            tile.width = w;
            tile.height = h;
            let planes = self.render_scene_inner_at(
                &tile,
                coherent,
                Rect::new(x as i32, y as i32, w, h),
                extra_halo,
            )?;
            if coherent {
                Ok(crate::fidelity::resolve_sample_planes([
                    &planes[0], &planes[1], &planes[2], &planes[3],
                ]))
            } else {
                Ok(planes.into_iter().next().expect("one render plane"))
            }
        }
    }
}
struct AccountedMask {
    mask: Mask,
    _allocation: Allocation,
}
struct AccountedSamples {
    masks: SampleMasks,
    _allocation: Allocation,
}
impl std::ops::Deref for AccountedSamples {
    type Target = SampleMasks;
    fn deref(&self) -> &SampleMasks { &self.masks }
}
impl Coverage for AccountedMask {
    fn rect(&self) -> Rect { self.mask.rect }
    fn at(&self, x: i32, y: i32) -> f32 { self.mask.at(x, y) }
}
impl Engine {
    /// Content revision of the loaded scene: bumped on every document
    /// install (load, patch, animation sample) and font change. This is the
    /// identity a [`crate::render_instruction::RenderInstruction`] compares
    /// to decide whether tiles must re-rasterise.
    pub fn content_revision(&self) -> u64 {
        self.geo_revision
    }

    /// Read/write access to the Sketch-parity tiled renderer owned by this
    /// engine. Created on first use with default (sequential) flags; native
    /// hosts flip `rasterize_concurrently` on through here.
    pub fn tiled_renderer_mut(
        &mut self,
    ) -> &mut crate::tiled_renderer::TiledRenderer {
        self.tiled.get_or_insert_with(crate::tiled_renderer::TiledRenderer::default)
    }

    pub fn tiled_renderer(&self) -> Option<&crate::tiled_renderer::TiledRenderer> {
        self.tiled.as_ref()
    }

    /// The render instruction for one frame under `options` — the identity
    /// the tiled renderer compares against what it already rendered. The
    /// viewport is the world rectangle the device viewport shows
    /// (`device = world * zoom + view.xy`, the camera matrix below).
    pub fn render_instruction_for(&self, options: &RenderOptions) -> Result<crate::render_instruction::RenderInstruction, String> {
        use crate::render_instruction::{ColorSpaceId, InstructionOptions};
        let zoom = options.view.zoom;
        if !zoom.is_finite() || zoom <= 0. {
            return Err("Invalid camera zoom for a render instruction".into());
        }
        Ok(crate::render_instruction::RenderInstruction {
            page_id: options.page_id.clone(),
            viewport: [
                -options.view.x / zoom,
                -options.view.y / zoom,
                f64::from(options.width) / zoom,
                f64::from(options.height) / zoom,
            ],
            zoom,
            level_scale: crate::tile_stack::exact_bucket_scale(zoom),
            backing_scale: 1.,
            content_revision: self.geo_revision,
            options: InstructionOptions::new(
                options.transparent,
                options.grid,
                options.raster_profile.tag(),
            )
            .with_interactive_effects(options.interactive_effects)
            .with_checkerboard(options.checkerboard),
            color_space: ColorSpaceId::of(&self.color_settings()),
        })
    }

    /// One Sketch-parity canvas frame: derive the instruction from
    /// `options`, run the tiled renderer (instruction-equality skip, dirty
    /// tiles only, restamp outside damage) and hand back the tiles the
    /// compositor must (re)draw plus the concatenated bytes. Equal frames
    /// return an empty tile list — nothing rasterised, exactly like an
    /// unchanged `MSRenderInstruction`.
    pub fn update_tiled_frame(
        &mut self,
        options: &RenderOptions,
        damage: Option<&[crate::render_instruction::WorldRect]>,
    ) -> Result<crate::tiled_renderer::TiledFrame, String> {
        let instruction = self.render_instruction_for(options)?;
        if options.pixel_preview.is_some() {
            return Err("Pixel preview presents a resampled frame".into());
        }
        // The renderer drives this engine as its raster source, so it must
        // step outside the struct for the duration of the update.
        let mut renderer = std::mem::take(
            self.tiled.get_or_insert_with(crate::tiled_renderer::TiledRenderer::default),
        );
        let status = renderer.update_with_instruction(self, options, &instruction, damage);
        let previous_level = renderer.previous_level();
        let telemetry = renderer.telemetry().report_statistics();
        self.tiled = Some(renderer);
        // Both hosts (wasm assembly and the native tiled host) rebuild the
        // full canvas per frame, so the payload is the visible resident set —
        // not Sketch's incremental redraw set, which would drop tiles that
        // stayed resident through a pan.
        let mut frame = self.tiled_frame_payload(options, &instruction, status?);
        frame.previous_level = previous_level;
        frame.telemetry = telemetry;
        Ok(frame)
    }

    /// After `update_tiled_frame`, every resident tile of the composited
    /// level (dirty or not) — the upload set for a canvas rebuild after
    /// resize or device loss.
    pub fn tiled_visible_tiles(
        &mut self,
        options: &RenderOptions,
    ) -> Result<crate::tiled_renderer::TiledFrame, String> {
        let instruction = self.render_instruction_for(options)?;
        // Ensure the level exists even before any update ran.
        self.tiled_renderer_mut()
            .tile_level_with_scale(instruction.level_scale)?;
        Ok(self.tiled_frame_payload(options, &instruction, crate::tiled_renderer::UpdateStatus::Completed))
    }

    fn tiled_frame_payload(
        &mut self,
        options: &RenderOptions,
        instruction: &crate::render_instruction::RenderInstruction,
        status: crate::tiled_renderer::UpdateStatus,
    ) -> crate::tiled_renderer::TiledFrame {
        let scale = instruction.level_scale;
        let level_index = crate::tiled_renderer::level_index_for_scale(scale);
        let mut tiles = Vec::new();
        let mut bytes = Vec::new();
        if let Some(level) = self.tiled_renderer().and_then(|r| r.level(level_index)) {
            // Visible residency only: hosts assemble the current viewport, so
            // offscreen history tiles must not ride along (they would blit at
            // their fixed world position forever — the ghost-trail bug).
            let selected: Vec<[i32; 2]> = level
                .addresses_for_world(instruction.viewport)
                .unwrap_or_default();
            tiles.reserve(selected.len());
            for address in selected {
                let Some(entry) = level.tile(&address) else {
                    continue;
                };
                tiles.push(crate::tiled_renderer::TiledTile {
                    level: level_index,
                    address,
                    world: level.tile_world_rect(address),
                    content_revision: entry.content_revision,
                    byte_offset: bytes.len(),
                    byte_len: entry.surface.bytes().len(),
                });
                bytes.extend_from_slice(entry.surface.bytes());
            }
        }
        let renderer = self.tiled_renderer().expect("payload after update");
        crate::tiled_renderer::TiledFrame {
            status,
            level: level_index,
            previous_level: renderer.previous_level(),
            level_scale: scale,
            zoom: options.view.zoom,
            telemetry: renderer.telemetry().report_statistics(),
            tiles,
            bytes,
        }
    }

    /// One device frame assembled from tiled residency: the Sketch-parity
    /// update runs first (equal instructions rasterise nothing, damage
    /// re-rasterises only dirty tiles), then the visible residency
    /// composites into a `width × height` RGBA buffer. Bucket-snapped zooms
    /// assemble with the byte-exact integer blit; off-bucket zooms resample
    /// the bucket content — see [`crate::tiled_renderer::assemble_rgba`].
    pub fn render_tiled_frame(
        &mut self,
        options: &RenderOptions,
        damage: Option<&[crate::render_instruction::WorldRect]>,
    ) -> Result<crate::tiled_renderer::AssembledFrame, String> {
        // Core update only — no payload byte concatenation, the composition
        // reads residency surfaces directly.
        let instruction = self.render_instruction_for(options)?;
        if options.pixel_preview.is_some() {
            return Err("Pixel preview presents a resampled frame".into());
        }
        let mut renderer = std::mem::take(
            self.tiled
                .get_or_insert_with(crate::tiled_renderer::TiledRenderer::default),
        );
        let status = renderer.update_with_instruction(self, options, &instruction, damage);
        let previous_level = renderer.previous_level();
        let telemetry = renderer.telemetry().report_statistics();
        self.tiled = Some(renderer);
        let status = status?;
        let level_index = crate::tiled_renderer::level_index_for_scale(instruction.level_scale);
        let mut pairs: Vec<([f64; 4], &[u8])> = Vec::new();
        if let Some(level) = self.tiled_renderer().and_then(|r| r.level(level_index)) {
            for address in level.addresses_for_world(instruction.viewport)? {
                if let Some(entry) = level.tile(&address) {
                    pairs.push((level.tile_world_rect(address), entry.surface.bytes()));
                }
            }
        }
        let visible_tiles = pairs.len();
        let rgba = crate::tiled_renderer::assemble_tiles(
            pairs.into_iter(),
            instruction.level_scale,
            options,
        );
        Ok(crate::tiled_renderer::AssembledFrame {
            status,
            level: level_index,
            previous_level,
            level_scale: instruction.level_scale,
            telemetry,
            visible_tiles,
            rgba,
        })
    }

    /// An isolated engine sharing fonts, decoded images and flattened path
    /// caches through Arc clones — the worker context Sketch's
    /// `_doParallelRasterisationOfScene` draws through (one CGContext per
    /// worker over the same immutable scene). Camera prepare caches are not
    /// shared: each worker computes its own for the tile camera it serves.
    pub(crate) fn snapshot_worker(&self) -> Engine {
        Engine {
            source_doc: self.source_doc.clone(),
            source_doc_bytes: self.source_doc_bytes,
            retained_source_size: self.retained_source_size.clone(),
            text_base: self.text_base.clone(),
            animation_base: self.animation_base.clone(),
            animation_sample: self.animation_sample.clone(),
            layout_dirty: self.layout_dirty,
            doc: self.doc.clone(),
            fonts: self.fonts.clone(),
            images: self.images.clone(),
            paths: self.paths.clone(),
            local_strokes: self.local_strokes.clone(),
            stats: Stats::default(),
            scene_peak_bytes: 0,
            budget_rejections: 0,
            last_rejection: None,
            // Workers share the owner's ledger handle so GPU accounting is
            // not split across engine clones (clone = same Arc state).
            gpu_memory: self.gpu_memory.clone(),
            linear_tiles: std::collections::HashMap::new(),
            linear_tiles_order: Vec::new(),
            linear_tiles_options: None,
            geo_revision: self.geo_revision,
            interaction_transform_revision: None,
            camera_prepare: None,
            world_support: None,
            source_compile_context: None,
            pending_camera: None,
            pending_layout: self.pending_layout.clone(),
            camera_residency: crate::gpu::CameraResidency::default(),
            frame_scene: crate::gpu::FrameSceneContext::default(),
            page_support: None,
            render_index: self.render_index.clone(),
            tiled: None,
        }
    }

    /// Static interaction lanes may share immutable font/image/path resources
    /// after the host proves the complete source document is identical.
    pub(crate) fn snapshot_static_worker(&self) -> Option<Engine> {
        let source = self.source_doc.as_ref()?;
        if !source.animations.is_empty() || self.animation_sample.is_some() { return None; }
        Some(self.snapshot_worker())
    }
    /// Render-only root scope over the same authoritative document. The
    /// existing COW snapshot and patch admission keep component dependencies
    /// reachable without sending a second whole document through the UI.
    pub(crate) fn snapshot_render_roots(&self, page_id: &str, roots: &[String], neutral_page_group:bool) -> Result<Engine,String> {
        let source=self.source_doc.as_ref().ok_or("Load document before selecting render roots")?;
        let page=source.pages.iter().find(|page|page.id==page_id).ok_or("Unknown render page")?;
        let selected:std::collections::HashSet<_>=roots.iter().collect();
        if selected.len()!=roots.len() {return Err("Render roots must be unique roots of the requested page".into());}
        let parents:std::collections::HashMap<_,_>=source.nodes.iter().flat_map(|(id,n)|n.children.iter().map(move|child|(child,id))).collect();
        let mut ancestors=std::collections::HashSet::new();
        for id in roots {
            let mut at=id;
            while !page.children.contains(at) {
                let parent=parents.get(at).ok_or("Render roots must belong to the requested page")?;
                if selected.contains(parent) {return Err("Overlapping render roots".into());}
                let n=&source.nodes[*parent];
                // The opt-in normal case is the sole empty group on a page.
                // Keep that ancestor in the scoped document; only sibling
                // visibility changes. Every interval still gets its own pixels.
                let neutral=neutral_page_group&&n.kind=="group"&&n.blend=="normal"&&page.children.len()==1&&page.children[0]==n.id;
                if (n.blend!="pass-through"&&!neutral) || n.opacity!=1. || n.clip || n.mask ||
                    n.fills.iter().any(|p|p.visible) || n.strokes.iter().any(|p|p.visible) || n.effects.iter().any(|e|e.visible) ||
                    n.layout.is_some() || n.sizing.is_some() || n.constraints.is_some() || n.boolean_operation.is_some() ||
                    n.instance.is_some() || n.instance_origin.is_some() || n.component.is_some() || n.component_set || n.repeat.is_some() ||
                    !n.bindings.is_empty() || !n.variable_modes.is_empty() {return Err("Nested render scope crosses a dependent ancestor".into());}
                if neutral {
                    fn independent(doc:&Document,id:&str)->bool {
                        let Some(n)=doc.nodes.get(id)else{return false};if !n.visible{return true}
                        if n.mask||n.effects.iter().any(|e|e.visible&&matches!(e.kind.as_str(),"background-blur"|"glass")){return false}
                        if n.blend=="normal"{return true}
                        n.blend=="pass-through"&&n.opacity==1.&&!n.clip&&!n.effects.iter().any(|e|e.visible)&&
                            n.fills.iter().filter(|p|p.visible).all(|p|p.blend=="normal")&&
                            n.strokes.iter().filter(|s|s.visible).all(|s|s.paint.blend=="normal")&&
                            n.children.iter().all(|id|independent(doc,id))
                    }
                    if !n.children.iter().all(|id|independent(source,id)){return Err("Neutral group contains a dependent painter".into());}
                }
                ancestors.insert(*parent);at=parent;
            }
        }
        let mut scoped=self.snapshot_static_worker().ok_or("Animated render root scope is unsupported")?;
        let mut patch=crate::editing::DocumentPatch{fields:Default::default(),nodes:Default::default()};
        for id in page.children.iter().chain(ancestors.iter().flat_map(|id|source.nodes[*id].children.iter())) {
            if !selected.contains(id) && !ancestors.contains(id) && source.nodes[id].visible {
                let mut node=source.nodes[id].clone();node.visible=false;
                patch.nodes.insert(id.clone(),Some(node));
            }
        }
        if !patch.nodes.is_empty(){scoped.apply_document_patch_with_damage(&patch)?;}
        Ok(scoped)
    }
    /// Renew a native lane certificate after ordered patches. Compare the full
    /// canonical authored representation, including float spelling/sign and
    /// array order. IDs, revisions and approximate hashes are not evidence.
    pub(crate) fn snapshot_static_worker_matching(&self, json: &str) -> Option<Engine> {
        if crate::capacity::check_document_bytes(json.len()).is_err() { return None; }
        let source = self.source_doc.as_ref()?;
        if !source.animations.is_empty() || self.animation_sample.is_some() { return None; }
        let candidate: Document = serde_json::from_str(json).ok()?;
        if candidate.nodes.len() != source.nodes.len() || candidate.pages.len() != source.pages.len() { return None; }
        struct BoundedBytes(Vec<u8>);
        impl std::io::Write for BoundedBytes {
            fn write(&mut self, chunk: &[u8]) -> std::io::Result<usize> {
                if self.0.len().saturating_add(chunk.len()) > crate::capacity::document_byte_limit() {
                    return Err(std::io::Error::other("snapshot exceeds document byte budget"));
                }
                self.0.extend_from_slice(chunk);
                Ok(chunk.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let mut encoded = BoundedBytes(Vec::new());
        serde_json::to_writer(&mut encoded, &candidate).ok()?;
        let bytes = encoded.0;
        struct EqualBytes<'a> { bytes: &'a [u8], offset: usize }
        impl std::io::Write for EqualBytes<'_> {
            fn write(&mut self, chunk: &[u8]) -> std::io::Result<usize> {
                let end = self.offset.checked_add(chunk.len()).ok_or_else(|| std::io::Error::other("snapshot mismatch"))?;
                if self.bytes.get(self.offset..end) != Some(chunk) { return Err(std::io::Error::other("snapshot mismatch")); }
                self.offset = end;
                Ok(chunk.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let mut equal = EqualBytes { bytes: &bytes, offset: 0 };
        serde_json::to_writer(&mut equal, source).ok()?;
        if equal.offset != bytes.len() { return None; }
        self.snapshot_static_worker()
    }

}

impl crate::tiled_renderer::TileRasterizer for Engine {
    fn rasterize_tile(
        &mut self,
        request: &crate::tiled_renderer::TileRequest,
    ) -> Result<Vec<u8>, String> {
        self.render_device_rect(
            &request.options,
            0,
            0,
            request.options.width,
            request.options.height,
        )
    }
}

impl crate::tiled_renderer::TileRasterSource for Engine {
    fn content_revision(&self) -> u64 {
        Engine::content_revision(self)
    }

    fn prepare(&mut self, options: &RenderOptions) -> Result<(), String> {
        self.prepare_frame(options)?;
        self.resolve_layout()?;
        Ok(())
    }

    fn spawn_worker(&self) -> Option<Box<dyn crate::tiled_renderer::TileRasterizer + Send>> {
        Some(Box::new(self.snapshot_worker()))
    }
}
impl std::ops::Deref for AccountedMask {
    type Target = Mask;
    fn deref(&self) -> &Mask {
        &self.mask
    }
}
struct Painter<'a> {
    doc: &'a Document,
    prepared: &'a HashMap<String, Prepared>,
    images: &'a mut Images,
    stats: &'a mut Stats,
    budget: Budget,
    extent: Rect,
    viewport: Rect,
    compatible: bool,
    coverage_compatible: bool,
    profile: crate::fidelity::RasterProfile,
    interactive_effects: bool,
    sample: Option<usize>,
    raster_workspace: RasterWorkspace,
}

enum TextureBundle {
    Unhandled,
    Captured,
    Passthrough,
}

/// Replay is restricted to one axis-aligned rectangular root clip. Retain the
/// renderer's actual per-AA coverage instead of clipping to the leaf or using
/// the root's conservative integer AABB at fractional frame boundaries.
fn texture_clip_rectangle(mask: &impl Coverage, viewport: Rect) -> Result<Rect, String> {
    let region = mask.rect().intersect(viewport);
    let mut bounds = None::<Rect>;
    let mut count = 0;
    for y in region.y..region.bottom() {
        for x in region.x..region.right() {
            match mask.at(x, y) {
                0. => (),
                1. => {
                    count += 1;
                    let pixel = Rect::new(x, y, 1, 1);
                    bounds = Some(bounds.map_or(pixel, |b| b.union(pixel)));
                }
                _ => return Err("Texture replay requires a binary rectangular parent clip".into()),
            }
        }
    }
    let result = bounds.unwrap_or(Rect::new(region.x, region.y, 0, 0));
    if result.pixels() != count {
        return Err("Texture replay parent clip is not rectangular".into());
    }
    Ok(result)
}

impl Drop for Painter<'_> {
    fn drop(&mut self) {
        let usage = self.budget.usage();
        self.stats.allocated_layer_pixels += usage.allocated_surface_pixels;
        self.stats.peak_layer_pixels = self.stats.peak_layer_pixels.max(usage.peak_surface_pixels);
        self.stats.peak_compositing_bytes = self.stats.peak_compositing_bytes.max(usage.peak_bytes);
    }
}
impl Painter<'_> {
    fn texture_bundle(
        &mut self,
        node: &Node,
        matrix: Transform,
        targets: &mut [Surface; 4],
        clip: Option<&AccountedSamples>,
    ) -> Result<TextureBundle, String> {
        if !self.compatible || !self.profile.is_export() {
            return Ok(TextureBundle::Unhandled);
        }
        let Some(effect) = node
            .effects
            .iter()
            .find(|e| e.visible && e.kind == "texture")
        else {
            return Ok(TextureBundle::Unhandled);
        };
        let Some(replay) = crate::texture_replay::recipe(self.doc, node, matrix, effect)? else {
            return Ok(TextureBundle::Unhandled);
        };
        let clip = clip.ok_or("Texture replay is missing its rectangular parent clip")?;
        let viewport = self.viewport.intersect(targets[0].rect);
        let tiles = replay.tiles(viewport)?;
        let region = tiles
            .iter()
            .map(|(_, r)| *r)
            .reduce(Rect::union)
            .unwrap_or(Rect::new(viewport.x, viewport.y, 0, 0));
        let mut sample_viewports = [Rect::default(); 4];
        for sample in 0..4 {
            if targets[sample].rect != targets[0].rect {
                return Err("Texture replay sample targets disagree".into());
            }
            sample_viewports[sample] = texture_clip_rectangle(&clip.plane(sample), region)?;
        }

        // Classify every tile/pass before painting. The low-radius contract is
        // ordinary paint with TEXTURE omitted; it must never re-enter the old
        // noise path or paint the entire node once for each empty tile.
        let mut capture = false;
        let mut passthrough = false;
        let mut unsupported = false;
        for (origin, _) in &tiles {
            for (sample, viewport) in sample_viewports.iter().enumerate() {
                match replay.tile(*origin, sample, *viewport)? {
                    crate::texture_replay::TileOutcome::Empty => (),
                    crate::texture_replay::TileOutcome::Passthrough => passthrough = true,
                    crate::texture_replay::TileOutcome::Capture(_) => capture = true,
                    crate::texture_replay::TileOutcome::Unsupported => unsupported = true,
                }
            }
        }
        // A legal, uncalibrated empty source falls back for the whole node.
        // Complete preflight first so an unrelated invalid-input error is not
        // hidden, and never return to ordinary paint after a partial capture.
        if unsupported {
            return Ok(TextureBundle::Unhandled);
        }
        if capture && passthrough {
            return Err("Texture replay mixes capture and passthrough tiles".into());
        }
        if passthrough {
            return Ok(TextureBundle::Passthrough);
        }
        for (origin, _) in tiles {
            for (sample, viewport) in sample_viewports.iter().enumerate() {
                match replay.tile(origin, sample, *viewport)? {
                    crate::texture_replay::TileOutcome::Empty => (),
                    crate::texture_replay::TileOutcome::Passthrough
                    | crate::texture_replay::TileOutcome::Unsupported => {
                        return Err("Texture replay changed its activation during rendering".into());
                    }
                    crate::texture_replay::TileOutcome::Capture(tile) => {
                        tile.render_into(&mut targets[sample])?;
                        let r = tile.capture.effect_rect;
                        let side = tile.capture.capture_pixels as i32;
                        let width = ((r[0] + r[2]).min(side) - r[0].max(0)).max(0) as usize;
                        let height = ((r[1] + r[3]).min(side) - r[1].max(0)).max(0) as usize;
                        self.stats.shaded_pixels += tile.expanded.coverage.pixels()
                            + tile.original.as_ref().map_or(0, |p| p.coverage.pixels())
                            + width * height
                            + tile.copyback_region.pixels();
                    }
                }
            }
        }
        if capture {
            self.stats.effect_layers += 1;
        }
        // The eligible leaf is the root frame's last child and has no later
        // readers. Only the requested viewport needs a parent writeback.
        Ok(TextureBundle::Captured)
    }

    fn allocate_bundle(&mut self, r: Rect) -> Result<[Surface; 4], String> {
        let mut out = Vec::with_capacity(4);
        for _ in 0..4 {
            out.push(self.allocate(r)?);
        }
        out.try_into().map_err(|_| "Invalid sample bundle".into())
    }
    fn resolve_backdrop(
        &mut self,
        r: Rect,
        origin: Point,
        targets: &[Surface; 4],
    ) -> Result<Surface, String> {
        let mut out = self.allocate(r)?;
        if !self.compatible {
            for y in r.y..r.bottom() {
                for x in r.x..r.right() {
                    let mut sum = [0.; 4];
                    for t in targets {
                        let p = t.sample_linear(
                            origin.x + f64::from(x - r.x) + 0.5,
                            origin.y + f64::from(y - r.y) + 0.5,
                        );
                        for (c, value) in sum.iter_mut().enumerate() {
                            *value += p.0[c] * 0.25;
                        }
                    }
                    out.pixels[r.index(x, y).expect("backdrop")] = Pixel(sum);
                }
            }
            self.stats.backdrop_reads += 1;
            return Ok(out);
        }
        for y in r.y..r.bottom() {
            for x in r.x..r.right() {
                let mut sum = [0_u32; 4];
                for t in targets {
                    let p = t.sample_rgba8(
                        origin.x + f64::from(x - r.x) + 0.5,
                        origin.y + f64::from(y - r.y) + 0.5,
                    );
                    for (c, value) in sum.iter_mut().enumerate() {
                        *value += (p.0[c].clamp(0., 1.) * 255.).round_ties_even() as u32;
                    }
                }
                out.pixels[r.index(x, y).expect("backdrop")] =
                    Pixel(sum.map(|v| ((v + 2) / 4) as f32 / 255.));
            }
        }
        self.stats.backdrop_reads += 1;
        Ok(out)
    }
    fn node_bundle(&mut self,id:&str,targets:&mut [Surface;4],clip:Option<&AccountedSamples>)->Result<(),String>{
        self.node_bundle_with_outline(id,targets,clip,false)
    }
    fn node_bundle_with_outline(
        &mut self,
        id: &str,
        targets: &mut [Surface; 4],
        clip: Option<&AccountedSamples>,
        inherited_outline: bool,
    ) -> Result<(), String> {
        let n = &self.doc.nodes[id];
        let geometric=inherited_outline || n.mask && n.mask_type.as_deref()==Some("outline");
        let outline=n.outline_mask_node(inherited_outline);
        let n=outline.as_ref().unwrap_or(n);
        if !n.visible || n.opacity <= 0. {
            return Ok(());
        }
        let prepared = &self.prepared[id];
        if prepared.bounds.intersect(targets[0].rect).empty() {
            self.stats.culled += 1;
            return Ok(());
        }
        let r = prepared.bounds.intersect(self.extent);
        let m = prepared.matrix;
        let scale = m.max_scale();
        self.stats.nodes += 1;
        let texture_passthrough = match self.texture_bundle(n, m, targets, clip)? {
            TextureBundle::Captured => return Ok(()),
            TextureBundle::Passthrough => true,
            TextureBundle::Unhandled => false,
        };
        let fill = self.rasterize_bundle(&prepared.fill, r, n.fill_even_odd() && n.kind != "text")?;
        let mask_id = self.doc.mask_child(n).map(|m| &m.id);
        let first = n.fills.iter().find(|p| p.visible);
        // A clipped, opaque container completely replaces the destination under
        // every covered sample. Painting it in place avoids four viewport copies.
        let in_place = clip.is_none()
            && mask_id.is_none()
            && n.opacity == 1.
            && n.blend == "normal"
            && !n.effects.iter().any(|e| e.visible)
            && !n.strokes.iter().any(|s| s.visible && s.width > 0.)
            && n.clip
            && first.is_some_and(|p| {
                p.opacity == 1.
                    && p.blend == "normal"
                    && p.kind != "image"
                    && crate::color::pixel(self.doc.color_management, &p.color, 1.)
                        .is_ok_and(|v| v.0[3] == 1.)
                    && p.stops.iter().all(|s| {
                        crate::color::pixel(self.doc.color_management, &s.color, 1.)
                            .is_ok_and(|v| v.0[3] == 1.)
                    })
            });
        if in_place {
            for sample in 0..4 {
                self.sample = Some(sample);
                for paint in &n.fills {
                    self.paint(n, paint, m, &fill.plane(sample), &mut targets[sample], |_, _| 1.)?;
                }
            }
            for child in n.render_children() {
                self.node_bundle_with_outline(child, targets, Some(&fill), geometric)?;
            }
            self.sample = None;
            return Ok(());
        }
        let mut layers = self.allocate_bundle(r)?;
        let passthrough = n.passes_backdrop();
        if passthrough {
            for sample in 0..4 {
                for y in r.y..r.bottom() {
                    for x in r.x..r.right() {
                        layers[sample].pixels[r.index(x, y).expect("backdrop")] =
                            targets[sample].at(x, y);
                    }
                }
            }
        }
        let mut coverage: Option<[Arc<Surface>; 4]> = None;
        let backgrounds: Vec<_> = n.backdrop_effect().into_iter().collect();
        if !backgrounds.is_empty() {
            let optical = crate::optics::GlassShape::from_node(n)
                .zip(n.backdrop_effect().and_then(|effect| effect.glass.as_ref()));
            let replay = if self.compatible && self.profile.is_export() {
                n.backdrop_effect()
                    .map(|fx| crate::glass_capture::recipe(self.doc, n, m, fx))
                    .transpose()?
                    .flatten()
            } else {
                None
            };
            let cropped = backgrounds.iter().all(|e| e.kind == "background-blur");
            let bounds = crate::coverage::backdrop_box(prepared.fill_bounds, self.extent);
            let capture = if cropped {
                Rect::new(0, 0, bounds[2] as u32, bounds[3] as u32)
            } else {
                r
            };
            let origin = if cropped {
                Point::new(bounds[0], bounds[1])
            } else {
                Point::new(f64::from(r.x), f64::from(r.y))
            };
            let mut background = if replay.is_some() {
                self.allocate(capture)?
            } else {
                self.resolve_backdrop(capture, origin, targets)?
            };
            let mut masks = Vec::with_capacity(4);
            for sample in 0..4 {
                let mask = fill.plane(sample);
                let mut surface = self.allocate(r)?;
                for y in r.y..r.bottom() {
                    for x in r.x..r.right() {
                        let a = mask.at(x, y);
                        surface.pixels[r.index(x, y).expect("mask")] = Pixel([a; 4]);
                    }
                }
                masks.push(Arc::new(surface));
            }
            let masks: [Arc<Surface>; 4] =
                masks.try_into().map_err(|_| "Invalid backdrop masks")?;
            for fx in backgrounds {
                if replay.is_some() {
                    continue;
                }
                background = if cropped && !self.compatible {
                    effects::linear_tent_blur(&background, fx.radius * scale, true)?
                } else if cropped {
                    effects::portable_tent_blur_edge(&background, fx.radius * scale, true)?
                } else {
                    self.blur_filter(fx.backdrop_radius() * scale)
                        .apply(&background)?
                };
                if let Some(controls) = &fx.color_controls { controls.apply(&mut background, self.doc.color_management.is_some()); }
                if fx.kind == "glass" && optical.is_none() {
                    let geometry = self.resolve_effect_planes(&masks)?;
                    background = effects::glass_unmasked(
                        &background,
                        &geometry,
                        crate::material::GlassMaterial::new(fx, scale),
                        self.compatible,
                    )?;
                }
            }
            for sample in 0..4 {
                let optical_surface = optical
                    .map(|(shape, glass)| {
                        if let Some(replay) = &replay {
                            self.stats.backdrop_reads +=
                                replay.tiles(r.intersect(self.viewport)).len();
                            return crate::optics::render_captured_with_raster(
                                &background,
                                replay,
                                shape,
                                m,
                                glass,
                                sample,
                                self.viewport,
                                self.profile.is_software(),
                            );
                        }
                        crate::optics::render_with_raster(
                            &background,
                            shape,
                            m,
                            glass,
                            Some(sample),
                            !self.compatible,
                            self.profile.is_software(),
                        )
                    })
                    .transpose()?;
                let background = optical_surface.as_ref().unwrap_or(&background);
                for y in r.y..r.bottom() {
                    for x in r.x..r.right() {
                        if !self.compatible {
                            layers[sample].pixels[r.index(x, y).expect("background")] = background
                                .sample_linear(
                                    (f64::from(x) + 0.5 - origin.x + f64::from(capture.x)).clamp(
                                        f64::from(capture.x) + 0.5,
                                        f64::from(capture.right()) - 0.5,
                                    ),
                                    (f64::from(y) + 0.5 - origin.y + f64::from(capture.y)).clamp(
                                        f64::from(capture.y) + 0.5,
                                        f64::from(capture.bottom()) - 0.5,
                                    ),
                                )
                                .opacity(fill.at(sample, x, y));
                            continue;
                        }
                        layers[sample].pixels[r.index(x, y).expect("background")] = background
                            .sample_rgba8(
                                (f64::from(x) + 0.5 - origin.x + f64::from(capture.x)).clamp(
                                    f64::from(capture.x) + 0.5,
                                    f64::from(capture.right()) - 0.5,
                                ),
                                (f64::from(y) + 0.5 - origin.y + f64::from(capture.y)).clamp(
                                    f64::from(capture.y) + 0.5,
                                    f64::from(capture.bottom()) - 0.5,
                                ),
                            )
                            .opacity(fill.at(sample, x, y))
                            .rgba8_quantized();
                    }
                }
            }

            coverage = Some(masks);
        }
        for sample in 0..4 {
            self.sample = Some(sample);
            for paint in &n.fills {
                self.paint(n, paint, m, &fill.plane(sample), &mut layers[sample], |_, _| 1.)?;
            }
        }
        if let Some(mask_id) = mask_id {
            let mut masks = self.allocate_bundle(r)?;
            self.node_bundle_with_outline(mask_id, &mut masks, None, geometric)?;
            let mut content = self.allocate_bundle(r)?;
            if passthrough {
                for sample in 0..4 {
                    content[sample]
                        .pixels
                        .clone_from_slice(&layers[sample].pixels);
                }
            }
            for child in n.render_children() {
                if child != mask_id {
                    self.node_bundle_with_outline(child, &mut content, if n.clip { Some(&fill) } else { None }, geometric)?;
                }
            }
            for sample in 0..4 {
                if passthrough {
                    layers[sample].interpolate(
                        &content[sample],
                        |x, y| {
                            masks[sample].at(x, y).mask_alpha(
                                self.doc.nodes[mask_id].mask_type.as_deref() == Some("luminance"),
                            )
                        },
                        self.compatible,
                    );
                } else {
                    layers[sample].composite(&content[sample], "normal", 1., |x, y| {
                        masks[sample].at(x, y).mask_alpha(
                            self.doc.nodes[mask_id].mask_type.as_deref() == Some("luminance"),
                        )
                    });
                }
                if self.compatible {
                    layers[sample].quantize_rgba8();
                }
            }
        } else {
            for child in n.render_children() {
                self.node_bundle_with_outline(child, &mut layers, if n.clip { Some(&fill) } else { None }, geometric)?;
            }
        }
        for (i, stroke) in n.strokes.iter().enumerate().filter(|(_, s)| s.visible && s.width > 0.) {
            let masks = self.rasterize_bundle(&prepared.strokes[i], r, false)?;
            for sample in 0..4 {
                self.sample = Some(sample);
                self.paint(n, &stroke.paint, m, &masks.plane(sample), &mut layers[sample],
                    |x, y| match stroke.align.as_str() {
                        "inside" => fill.at(sample, x, y),
                        "outside" => 1. - fill.at(sample, x, y),
                        _ => 1.,
                    },
                )?;
            }
        }
        self.sample = None;
        let mut planes = layers.map(Arc::new);
        if !texture_passthrough && n.effects.iter().any(|e| e.visible) {
            planes = self.apply_foreground_coverage(id, planes, &mut coverage)?;
        }
        let blend_mode=crate::blend::BlendMode::from_name(n.composite_blend());
        let byte_opacity=self.compatible && matches!(blend_mode,crate::blend::BlendMode::Normal|crate::blend::BlendMode::Multiply|crate::blend::BlendMode::Screen)
            && n.opacity<1. && coverage.is_none();
        for sample in 0..4 {
            let source = &planes[sample];
            let target = &mut targets[sample];
            let region = source.rect.intersect(target.rect);
            for y in region.y..region.bottom() {
                for x in region.x..region.right() {
                    let opacity = n.opacity as f32 * clip.map_or(1., |m| m.at(sample, x, y));
                    let src = source.at(x, y).opacity(opacity);
                    let dst = target.at(x, y);
                    if passthrough {
                        target.pixels[target.rect.index(x, y).expect("pass through")] =
                            dst.interpolate(source.at(x, y), opacity, self.compatible);
                        continue;
                    }
                    if byte_opacity {
                        target.pixels[target.rect.index(x, y).expect("opacity composite")] =
                            dst.over_rgba8_mode(source.at(x, y), opacity, blend_mode);
                        continue;
                    }
                    let mut value = crate::blend::over_mode(dst, src, blend_mode);
                    // A filtered backdrop replaces the covered destination; normal
                    // source-over would count semi-transparent backdrop alpha twice.
                    if let Some(mask) = &coverage {
                        let extra = (mask[sample].at(x, y).0[3] * opacity - src.0[3]).max(0.);
                        for c in 0..4 {
                            value.0[c] -= dst.0[c] * extra;
                        }
                    }
                    target.pixels[target.rect.index(x, y).expect("composite")] = if self.compatible
                    {
                        value.rgba8_quantized()
                    } else {
                        value
                    };
                }
            }
        }

        Ok(())
    }
    fn blur_filter(&self, radius: f64) -> effects::BlurFilter {
        if self.doc.color_management.is_some() {
            effects::BlurFilter::LinearTent(radius)
        } else if self.compatible {
            effects::BlurFilter::PortableTent(f64::from(radius as f32))
        } else {
            effects::BlurFilter::Gaussian(radius / 2.)
        }
    }
    fn rasterize_bundle(&mut self, contours: &[Contour], limit: Rect, even_odd: bool) -> Result<AccountedSamples, String> {
        let allocation = self.budget.reserve(limit.pixels(), 1, false)?;
        let masks = self.raster_workspace.samples(contours, limit, even_odd)?;
        Ok(AccountedSamples { masks, _allocation: allocation })
    }
    fn rasterize(
        &mut self,
        contours: &[Contour],
        limit: Rect,
        even_odd: bool,
    ) -> Result<AccountedMask, String> {
        let allocation = self
            .budget
            .reserve(limit.pixels(), size_of::<f32>(), false)?;
        let mask = if self.coverage_compatible && self.doc.color_management.is_some() {
            self.raster_workspace.sample(contours, limit, even_odd, self.sample, false)?
        } else if self.coverage_compatible {
            self.raster_workspace.sample(contours, limit, even_odd, self.sample, true)?
        } else {
            self.raster_workspace.area(contours, limit, even_odd)?
        };
        Ok(AccountedMask {
            mask,
            _allocation: allocation,
        })
    }

    fn allocate(&mut self, rect: Rect) -> Result<Surface, String> {
        Surface::new_in(rect, &self.budget)
    }
    fn paint(
        &mut self,
        n: &Node,
        p: &Paint,
        m: Transform,
        mask: &impl Coverage,
        layer: &mut Surface,
        extra: impl Fn(i32, i32) -> f32,
    ) -> Result<(), String> {
        let basis = layer.rect.intersect(mask.rect());
        self.paint_region(n, p, m, mask, layer, basis, extra)
    }
    fn paint_region(
        &mut self, n: &Node, p: &Paint, m: Transform, mask: &impl Coverage,
        layer: &mut Surface, basis: Rect, extra: impl Fn(i32, i32) -> f32,
    ) -> Result<(), String> {
        if !p.visible {
            return Ok(());
        }
        let blend_mode=crate::blend::BlendMode::from_name(&p.blend);
        let r = layer.rect.intersect(mask.rect());
        let mut sampler = Sampler::new(p, n, m, basis, self.images)?;
        sampler.prepare_sampled(p, r, !self.compatible)?;
        let solid = sampler.solid();
        let direct_constant = if self.compatible && self.sample.is_some() && p.blend == "normal" {
            p.constant_color()
                .map(|color| {
                    crate::color::pixel(self.doc.color_management, color, p.opacity as f32)
                })
                .transpose()?
        } else {
            None
        };
        let measured_gradient = if self.compatible
            && self.profile.is_export()
            && crate::figma_gradient::supported(p, m)
        {
            self.sample
                .map(|sample| {
                    Ok::<_, String>((
                        crate::figma_gradient::from_paint(p)?,
                        crate::figma_gradient::Coordinates::with_raster(
                            r,
                            m,
                            [n.width, n.height],
                            p,
                            sample,
                            self.profile.is_software(),
                        )?,
                    ))
                })
                .transpose()?
        } else {
            None
        };
        let quantized_solid = if self.compatible && self.sample.is_some() {
            sampler.solid_rgba8()
        } else {
            None
        };
        for y in r.y..r.bottom() {
            for x in r.x..r.right() {
                let alpha = mask.at(x, y) * extra(x, y);
                if alpha <= 0. {
                    continue;
                }
                if let Some((gradient, coordinates)) = &measured_gradient {
                    let values = coordinates.at(x, y)?;
                    let color = gradient
                        .sample_with_raster(values[0], self.profile.is_software())
                        .map_err(|e| e.to_string())?
                        .map(|v| v * p.opacity as f32);
                    if color[3] == 0. {
                        continue;
                    }
                    let mut source = color.map(|v| (v + values[1]).abs().min(1.));
                    if color[3] == 1. {
                        source[3] = 1.;
                    }
                    let source = source.map(|v| v * alpha);
                    let i = layer.rect.index(x, y).expect("gradient paint");
                    if self.profile.is_software() {
                        layer.pixels[i] =
                            Pixel(crate::software_raster::over(layer.pixels[i].0, source));
                        self.stats.shaded_pixels += 1;
                        continue;
                    }
                    let factor = 1. - source[3];
                    layer.pixels[i] = Pixel(std::array::from_fn(|c| {
                        f32::from(crate::figma_sampling::encode_unorm8(
                            layer.pixels[i].0[c]
                                .mul_add(factor, source[c])
                                .clamp(0., 1.),
                        )) / 255.
                    }));
                    self.stats.shaded_pixels += 1;
                    continue;
                }
                if (0. ..=1.).contains(&alpha)
                    && let Some(source) = direct_constant
                {
                    let source = source.opacity(alpha);
                    let i = layer.rect.index(x, y).expect("solid paint");
                    if self.profile.is_software() {
                        layer.pixels[i] =
                            Pixel(crate::software_raster::over(layer.pixels[i].0, source.0));
                        self.stats.shaded_pixels += 1;
                        continue;
                    }
                    let factor = 1. - source.0[3];
                    layer.pixels[i] = Pixel(std::array::from_fn(|c| {
                        let value = layer.pixels[i].0[c].mul_add(factor, source.0[c]);
                        f32::from(crate::figma_sampling::encode_unorm8(value.clamp(0., 1.))) / 255.
                    }));
                    self.stats.shaded_pixels += 1;
                    continue;
                }
                let pixel = if let Some(pixel) = quantized_solid.filter(|_| alpha == 1.) {
                    pixel
                } else {
                    let mut pixel = solid
                        .unwrap_or_else(|| {
                            let (sx, sy) = self
                                .sample
                                .map_or((0.5, 0.5), |i| crate::fidelity::SAMPLE_OFFSETS[i]);
                            let point = Point::new(x as f64 + sx, y as f64 + sy);
                            if self.compatible && self.sample.is_some() && alpha == 1. {
                                sampler.at_rgba8(point)
                            } else {
                                sampler.at(point)
                            }
                        })
                        .opacity(alpha);
                    if self.compatible && self.sample.is_some() {
                        pixel = pixel.rgba8_quantized();
                    }
                    pixel
                };
                let i = layer.rect.index(x, y).expect("paint");
                layer.pixels[i] = crate::blend::over_mode(layer.pixels[i], pixel, blend_mode);
                if self.compatible {
                    layer.pixels[i] = layer.pixels[i].rgba8_quantized();
                }
                self.stats.shaded_pixels += 1;
            }
        }
        Ok(())
    }
    fn resolve_effect_planes(&mut self, planes: &[Arc<Surface>; 4]) -> Result<Surface, String> {
        let mut resolved = self.allocate(planes[0].rect)?;
        for (i, pixel) in resolved.pixels.iter_mut().enumerate() {
            if !self.compatible {
                *pixel = Pixel(std::array::from_fn(|c| {
                    planes.iter().map(|p| p.pixels[i].0[c] * 0.25).sum()
                }));
                continue;
            }
            let mut sum = [0_u32; 4];
            for plane in planes {
                for (c, value) in sum.iter_mut().enumerate() {
                    *value += (plane.pixels[i].0[c].clamp(0., 1.) * 255.).round_ties_even() as u32;
                }
            }
            *pixel = Pixel(sum.map(|v| ((v + 2) / 4) as f32 / 255.));
        }
        Ok(resolved)
    }
    fn apply_foreground_coverage(
        &mut self,
        id: &str,
        mut planes: [Arc<Surface>; 4],
        coverage: &mut Option<[Arc<Surface>; 4]>,
    ) -> Result<[Arc<Surface>; 4], String> {
        let n = &self.doc.nodes[id];
        let m = self.prepared[id].matrix;
        let scale = m.max_scale();
        for fx in n
            .effects
            .iter()
            .filter(|e| e.visible && !matches!(e.kind.as_str(), "background-blur" | "glass"))
        {
            if (fx.kind == "blur"
                && !crate::fidelity::layer_blur_active(
                    fx.blur_radius() * scale,
                    self.profile,
                    self.doc.color_management.is_some(),
                    self.interactive_effects,
                ))
                || (fx.kind == "texture" && fx.texture_amount() == 0.)
            {
                continue;
            }
            if fx.kind == "color-controls" {
                let controls = fx.color_controls.as_ref().ok_or("Missing color controls")?;
                if controls.is_identity() { continue; }
                let mut outputs: Vec<Arc<Surface>> = Vec::new();
                for (i, source) in planes.iter().enumerate() {
                    if let Some(previous) = planes[..i].iter().position(|p|Arc::ptr_eq(p,source)) {
                        outputs.push(outputs[previous].clone()); continue;
                    }
                    let mut output = source.try_clone()?;
                    controls.apply(&mut output, self.doc.color_management.is_some());
                    if self.compatible { output.quantize_rgba8(); }
                    outputs.push(Arc::new(output));
                }
                planes = outputs.try_into().map_err(|_| "Invalid color control planes")?;
                continue;
            }
            let resolved = self.resolve_effect_planes(&planes)?;
            if matches!(fx.kind.as_str(), "gaussian-blur" | "motion-blur" | "zoom-blur") {
                let kernel=if fx.kind=="motion-blur" {Some(crate::spatial_blur::MotionKernel::new(fx.radius,fx.motion_angle,m)?)} else {None};
                let compatible=self.compatible;
                let filter=|source:&Surface| -> Result<Surface,String> {
                    let mut value=if let Some(z)=fx.zoom_blur {crate::zoom_blur::apply(source,z,m,[n.width,n.height])?}
                        else if let Some(kernel)=&kernel {kernel.apply(source)?}
                        else {effects::gaussian_surface(source,fx.radius*scale,compatible)?};
                    if compatible {value.quantize_rgba8();} Ok(value)
                };
                let out=Arc::new(filter(&resolved)?);planes=std::array::from_fn(|_|out.clone());
                if let Some(mask)=coverage {let value=Arc::new(filter(&self.resolve_effect_planes(mask)?)?);*mask=std::array::from_fn(|_|value.clone());}
            } else if fx.kind == "blur" {
                let blur_filter = self.blur_filter(fx.blur_radius() * scale);
                let compatible = self.compatible;
                let filter = |source: &Surface| -> Result<Surface, String> {
                    let blurred = blur_filter.apply(source)?;
                    if let Some(g) = &fx.gradient_blur {
                        let mut output = source.try_clone()?;
                        effects::gradient_blur_composite(
                            &mut output,
                            &blurred,
                            &m.inverse_composed(source.rect)?,
                            g,
                        );
                        if compatible {
                            output.quantize_rgba8();
                        }
                        Ok(output)
                    } else {
                        Ok(blurred)
                    }
                };
                let output = Arc::new(filter(&resolved)?);

                planes = std::array::from_fn(|_| output.clone());
                if let Some(mask) = coverage {
                    let resolved_mask = self.resolve_effect_planes(mask)?;
                    let filtered = Arc::new(filter(&resolved_mask)?);

                    *mask = std::array::from_fn(|_| filtered.clone());
                }
            } else if fx.kind == "shadow" || fx.kind == "inner-shadow" {
                let inner = fx.kind == "inner-shadow";
                let alpha = effects::shadow_alpha(
                    &resolved,
                    self.blur_filter(fx.blur_radius() * scale),
                    fx.spread * scale,
                    inner,
                )?;
                let offset = m.point(Point::new(fx.x, fx.y)) - m.point(Point::default());
                let pointwise = fx.radius == 0.
                    && fx.spread == 0.
                    && offset.x.fract() == 0.
                    && offset.y.fract() == 0.;
                let color = crate::color::pixel(self.doc.color_management, &fx.color, 1.)?.rgb();
                let mut outputs: Vec<Arc<Surface>> = Vec::with_capacity(4);
                for (i, source) in planes.iter().enumerate() {
                    if let Some(previous) = planes[..i].iter().position(|p| Arc::ptr_eq(p, source))
                    {
                        outputs.push(outputs[previous].clone());
                        continue;
                    }
                    let mut shadow = if !self.compatible {
                        effects::color_shadow_linear(
                            source,
                            if pointwise { source } else { &alpha },
                            crate::color::pixel(
                                self.doc.color_management,
                                &fx.color,
                                fx.opacity as f32,
                            )?,
                            offset.x,
                            offset.y,
                            inner,
                        )?
                    } else {
                        effects::color_shadow_rgba8(
                            source,
                            if pointwise { source } else { &alpha },
                            color,
                            fx.opacity as f32,
                            offset.x,
                            offset.y,
                            inner,
                        )?
                    };
                    if self.compatible {
                        shadow.quantize_rgba8();
                    }
                    let mut output = self.allocate(source.rect)?;
                    if inner {
                        output.pixels.clone_from_slice(&source.pixels);
                        output.composite(&shadow, "normal", 1., |_, _| 1.);
                    } else {
                        output.pixels.clone_from_slice(&shadow.pixels);
                        output.composite(source, "normal", 1., |_, _| 1.);
                    }
                    if self.compatible {
                        output.quantize_rgba8();
                    }
                    outputs.push(Arc::new(output));
                }

                planes = outputs
                    .try_into()
                    .map_err(|_| "Invalid effect output count".to_string())?;
            } else if matches!(fx.kind.as_str(), "noise" | "texture") {
                let mut outputs: Vec<Arc<Surface>> = Vec::new();
                for (i, source) in planes.iter().enumerate() {
                    if let Some(previous) = planes[..i].iter().position(|p| Arc::ptr_eq(p, source))
                    {
                        outputs.push(outputs[previous].clone());
                        continue;
                    }
                    let mut out = if fx.kind == "texture" {
                        if let Some(t) = &fx.texture {
                            crate::material::texture_at(
                                source,
                                fx.texture_amount(),
                                t,
                                m,
                                !self.compatible,
                                [n.width / 2., n.height / 2.],
                            )?
                        } else if self.doc.color_management.is_some() {
                            effects::texture_linear(source, fx.amount * fx.opacity * 2., m)?
                        } else {
                            effects::texture(source, fx.amount * fx.opacity * 2., m)?
                        }
                    } else {
                        source.as_ref().try_clone()?
                    };
                    if fx.kind == "noise" {
                        let inv = m.inverse_composed(out.rect)?;
                        for y in out.rect.y..out.rect.bottom() {
                            for x in out.rect.x..out.rect.right() {
                                let i = out.rect.index(x, y).expect("noise");
                                let p = out.pixels[i];
                                let q =
                                    inv.point(Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
                                let density = fx.amount.max(0.01);
                                let v = effects::noise(
                                    (q.x * density).floor() as i32,
                                    (q.y * density).floor() as i32,
                                    7,
                                );
                                out.pixels[i] = {
                                    let source = Pixel::rgba(v, v, v, fx.opacity as f32 * p.0[3]);
                                    over(
                                        p,
                                        if self.compatible {
                                            source.rgba8_quantized()
                                        } else {
                                            source
                                        },
                                        "soft-light",
                                    )
                                };
                            }
                        }
                    }
                    if self.compatible {
                        out.quantize_rgba8();
                    }
                    outputs.push(Arc::new(out));
                }

                planes = outputs
                    .try_into()
                    .map_err(|_| "Invalid procedural planes")?;
            } else {
                return Err(format!("Unsupported sampled effect {}", fx.kind));
            }
        }
        self.stats.effect_layers += 1;
        Ok(planes)
    }
    // The regional Gaussian proof is analytic and unmanaged. Unsupported
    // effects and mask subtrees keep their original full-domain evaluation.
    fn bounded_node(&self, id: &str) -> bool {
        let n = &self.doc.nodes[id];
        if !n.visible || n.opacity <= 0. { return true; }
        !self.coverage_compatible && self.doc.color_management.is_none()
            && !n.mask && self.doc.mask_child(n).is_none()
            && n.render_children().iter().all(|child| self.bounded_node(child))
            && n.effects.iter().filter(|e| e.visible).all(|e| {
                n.backdrop_effect().is_some_and(|b| std::ptr::eq(e, b))
                    && (e.kind != "glass" || (e.glass.is_some()
                        && crate::optics::GlassShape::from_node(n).is_some()))
            })
    }
    fn regional_children(&self, children: &[String], output: Rect) -> Result<(Rect, Vec<Rect>), String> {
        let mut needed = output;
        let mut outputs = Vec::with_capacity(children.len());
        for child in children.iter().rev() {
            outputs.push(needed);
            needed = needed.union(self.leaf_backdrop_input(child, needed)?);
        }
        outputs.reverse();
        Ok((needed, outputs))
    }
    fn leaf_backdrop_input(&self, id: &str, output: Rect) -> Result<Rect, String> {
        let n = &self.doc.nodes[id];
        if !n.visible || n.opacity <= 0. { return Ok(output); }
        if !self.bounded_node(id) { return Ok(self.extent); }
        let p = &self.prepared[id];
        let basis = p.bounds.intersect(self.extent);
        let output = output.intersect(basis);
        if output.empty() { return Ok(output); }
        let (working, _) = self.regional_children(n.render_children(), output)?;
        let working = working.intersect(basis);
        let mut input = if n.passes_backdrop() { working } else { output };
        if let Some(fx) = n.backdrop_effect() {
            let samples = if let Some((shape, glass)) = crate::optics::GlassShape::from_node(n).zip(fx.glass.as_ref()) {
                crate::optics::input_region(basis, working, shape, p.matrix, glass, None)?
            } else { working };
            let sigma = fx.backdrop_radius() * p.matrix.max_scale() / 2.;
            let support: u32 = effects::gaussian_box_radii(sigma)?.into_iter().sum();
            input = input.union(samples.expand(support as i32).intersect(basis));
        }
        Ok(input)
    }
    fn node_with_outline(&mut self,id:&str,target:&mut Surface,clip:Option<&Mask>,inherited_outline:bool)->Result<(),String>{
        let original_target=target.rect;
        self.node_region(id,target,clip,None,original_target,inherited_outline)
    }
    fn node_region(&mut self, id: &str, target: &mut Surface, clip: Option<&Mask>, output: Option<Rect>, original_target: Rect, inherited_outline:bool) -> Result<(), String> {
        let n = &self.doc.nodes[id];
        let geometric=inherited_outline || n.mask && n.mask_type.as_deref()==Some("outline");
        let outline=n.outline_mask_node(inherited_outline);
        let n=outline.as_ref().unwrap_or(n);
        if !n.visible || n.opacity <= 0. {
            return Ok(());
        }
        let Some(layer) = self.node_layer(id, target, true, output, original_target, geometric)? else {
            return Ok(());
        };
        if n.passes_backdrop() {
            target.interpolate(
                &layer,
                |x, y| n.opacity as f32 * clip.map_or(1., |m| m.at(x, y)),
                self.compatible,
            );
        } else if self.compatible && n.composite_blend() == "normal" && n.opacity < 1. {
            // The single-layer fast profile must use the same opacity contract
            // as correlated sample planes, including intermediate byte storage.
            target.composite_rgba8(&layer, n.opacity as f32, |x, y| {
                clip.map_or(1., |m| m.at(x, y))
            });
        } else {
            target.composite(&layer, n.composite_blend(), n.opacity as f32, |x, y| {
                clip.map_or(1., |m| m.at(x, y))
            });
        }
        if self.compatible {
            target.quantize_rgba8();
        }

        Ok(())
    }
    fn node_layer(
        &mut self,
        id: &str,
        target: &Surface,
        apply_effects: bool,
        output: Option<Rect>,
        original_target: Rect,
        inherited_outline: bool,
    ) -> Result<Option<Surface>, String> {
        let n = &self.doc.nodes[id];
        let geometric=inherited_outline || n.mask && n.mask_type.as_deref()==Some("outline");
        let outline=n.outline_mask_node(inherited_outline);
        let n=outline.as_ref().unwrap_or(n);
        if !n.visible {
            return Ok(None);
        }
        let prepared = &self.prepared[id];
        // Nonlocal effects read their source/geometry before ancestor clipping.
        // Cropping first creates artificial blur edges AND glass distance-field
        // boundaries, especially when a deep or dispersed lens crosses a frame.
        let filtered = n.effects.iter().any(|e| {
            e.visible
                && matches!(
                    e.kind.as_str(),
                    "blur" | "gaussian-blur" | "motion-blur" | "zoom-blur" | "shadow" | "inner-shadow" | "glass" | "texture"
                )
        });
        let basis = prepared
            .bounds
            .intersect(if filtered { self.extent } else { original_target })
            .intersect(self.extent);
        // Preparation can reject a clipped frame without preparing descendants.
        // Do not run dependency planning inside that already-culled subtree.
        if basis.empty() {
            self.stats.culled += 1;
            return Ok(None);
        }
        let bounded = output.is_some() && self.bounded_node(id);
        let r = if bounded {
            self.regional_children(n.render_children(), basis.intersect(output.unwrap()))?.0.intersect(basis)
        } else { basis };
        if r.empty() {
            self.stats.culled += 1;
            return Ok(None);
        }
        self.stats.nodes += 1;
        let mut layer = self.allocate(r)?;
        let passthrough = n.passes_backdrop();
        if passthrough {
            for y in r.y..r.bottom() {
                for x in r.x..r.right() {
                    layer.pixels[r.index(x, y).expect("backdrop")] = target.at(x, y);
                }
            }
        }
        let m = prepared.matrix;
        let scale = m.max_scale();
        let fill = self.rasterize(
            &prepared.fill,
            r,
            n.fill_even_odd() && n.kind != "text",
        )?;
        if let Some(fx) = n.backdrop_effect().filter(|_| apply_effects) {
            let mut blurred = if bounded {
                let samples = if let Some((shape, glass)) = crate::optics::GlassShape::from_node(n).zip(fx.glass.as_ref()) {
                    crate::optics::input_region(basis, r, shape, m, glass, None)?
                } else { r };
                effects::gaussian_region(target, basis, samples, fx.backdrop_radius() * scale / 2.)?
            } else {
                let copy = effects::copy_region(target, r)?;
                self.blur_filter(fx.backdrop_radius() * scale).apply(&copy)?
            };
            if let Some(controls) = &fx.color_controls { controls.apply(&mut blurred, self.doc.color_management.is_some()); }
            let background = if let Some((shape, glass)) =
                crate::optics::GlassShape::from_node(n).zip(fx.glass.as_ref())
            {
                if bounded {
                    crate::optics::render_region_with_raster(&blurred, basis, r, shape, m, glass, None, !self.compatible, false)?
                } else {
                    crate::optics::render(&blurred, shape, m, glass, None, !self.compatible)?
                }
            } else if fx.kind == "glass" {
                let mut geometry = self.allocate(r)?;
                for y in r.y..r.bottom() {
                    for x in r.x..r.right() {
                        geometry.pixels[r.index(x, y).expect("in-bounds glass geometry")] =
                            Pixel([fill.at(x, y); 4]);
                    }
                }
                effects::glass_unmasked(
                    &blurred,
                    &geometry,
                    crate::material::GlassMaterial::new(fx, scale),
                    self.compatible,
                )?
            } else {
                blurred
            };
            for y in r.y..r.bottom() {
                for x in r.x..r.right() {
                    layer.pixels[r.index(x, y).expect("in-bounds backdrop")] =
                        background.at(x, y).opacity(fill.at(x, y));
                }
            }
        }
        for paint in &n.fills {
            if bounded {
                self.paint_region(n, paint, m, &fill, &mut layer, basis.intersect(prepared.fill_program_bounds), |_, _| 1.)?;
            } else {
                self.paint(n, paint, m, &fill, &mut layer, |_, _| 1.)?;
            }
        }
        let mask_id = self.doc.mask_child(n).map(|m| &m.id);
        let mut mask_surface = None;
        if let Some(id) = mask_id {
            let mut mask = self.allocate(r)?;
            self.node_with_outline(id, &mut mask, None, geometric)?;
            mask_surface = Some(mask);
        }
        let child_mask = if n.clip { Some(&*fill) } else { None };
        if let Some(mask) = &mask_surface {
            let mut content = self.allocate(r)?;
            if passthrough {
                content.pixels.clone_from_slice(&layer.pixels);
            }
            for child in n.render_children() {
                if Some(child) != mask_id {
                    self.node_with_outline(child, &mut content, child_mask, geometric)?;
                }
            }
            if passthrough {
                layer.interpolate(
                    &content,
                    |x, y| {
                        mask.at(x, y).mask_alpha(mask_id.is_some_and(|id| {
                            self.doc.nodes[id].mask_type.as_deref() == Some("luminance")
                        }))
                    },
                    self.compatible,
                );
            } else {
                layer.composite(&content, "normal", 1., |x, y| {
                    mask.at(x, y).mask_alpha(mask_id.is_some_and(|id| {
                        self.doc.nodes[id].mask_type.as_deref() == Some("luminance")
                    }))
                });
                if self.compatible {
                    layer.quantize_rgba8();
                }
            }
        } else if bounded {
            let children: Vec<String> = n.render_children().to_vec();
            let (_, outputs) = self.regional_children(&children, basis.intersect(output.unwrap()))?;
            for (child, region) in children.iter().zip(outputs) {
                self.node_region(child, &mut layer, child_mask, Some(region), basis, geometric)?;
            }
        } else {
            for child in n.render_children() {
                self.node_with_outline(child, &mut layer, child_mask, geometric)?;
            }
        }
        for (i, s) in n.strokes.iter().enumerate() {
            if !s.visible || s.width <= 0. {
                continue;
            }
            let mask = self.rasterize(&prepared.strokes[i], r, false)?;
            let paint_basis = if bounded { basis.intersect(prepared.stroke_program_bounds[i]) }
                else { layer.rect.intersect(mask.rect) };
            self.paint_region(n, &s.paint, m, &mask, &mut layer, paint_basis, |x, y| {
                match s.align.as_str() {
                    "inside" => fill.at(x, y),
                    "outside" => 1. - fill.at(x, y),
                    _ => 1.,
                }
            })?;
        }
        for fx in n.effects.iter().filter(|e| apply_effects && e.visible) {
            match fx.kind.as_str() {
                "zoom-blur" => { layer=crate::zoom_blur::apply(&layer,fx.zoom_blur.ok_or("Missing zoom parameters")?,m,[n.width,n.height])?; }
                "gaussian-blur" => { layer=effects::gaussian_surface(&layer,fx.radius*scale,self.compatible)?; }
                "motion-blur" => { layer=crate::spatial_blur::MotionKernel::new(fx.radius,fx.motion_angle,m)?.apply(&layer)?; }
                "color-controls" => {
                    fx.color_controls.as_ref().ok_or("Missing color controls")?.apply(&mut layer, self.doc.color_management.is_some());
                }
                "shadow" | "inner-shadow" => {
                    let offset = m.point(Point::new(fx.x, fx.y)) - m.point(Point::default());
                    let mut shadow = if self.compatible {
                        let inner = fx.kind == "inner-shadow";
                        let alpha = effects::shadow_alpha(
                            &layer,
                            self.blur_filter(fx.radius * scale),
                            fx.spread * scale,
                            inner,
                        )?;
                        effects::color_shadow_rgba8(
                            &layer,
                            &alpha,
                            crate::color::pixel(self.doc.color_management, &fx.color, 1.)?.rgb(),
                            fx.opacity as f32,
                            offset.x,
                            offset.y,
                            inner,
                        )?
                    } else {
                        effects::shadow_with_filter(
                            &layer,
                            crate::color::pixel(
                                self.doc.color_management,
                                &fx.color,
                                fx.opacity as f32,
                            )?,
                            self.blur_filter(fx.radius * scale),
                            fx.spread * scale,
                            offset.x,
                            offset.y,
                            fx.kind == "inner-shadow",
                        )?
                    };
                    if self.compatible {
                        shadow.quantize_rgba8();
                    }
                    if fx.kind == "shadow" {
                        let original = layer;
                        layer = shadow;
                        layer.composite(&original, "normal", 1., |_, _| 1.);
                    } else {
                        layer.composite(&shadow, "normal", 1., |_, _| 1.);
                    }
                }
                "blur" => {
                    if let Some(gb) = &fx.gradient_blur {
                        // Gradient-modulated blur: render the fully blurred
                        // layer at the peak strength, then blend it against
                        // the sharp layer through the tier weight curves.
                        let peak = fx.blur_radius() * scale;
                        let blurred = self.blur_filter(peak).apply(&layer)?;
                        let inverse = m.inverse_composed(r)?;
                        effects::gradient_blur_composite(&mut layer, &blurred, &inverse, gb);
                        if self.compatible {
                            layer.quantize_rgba8();
                        }
                    } else if crate::fidelity::layer_blur_active(
                        fx.radius * scale,
                        self.profile,
                        self.doc.color_management.is_some(),
                        self.interactive_effects,
                    ) {
                        layer = self.blur_filter(fx.radius * scale).apply(&layer)?;
                    }
                }
                "texture" => {
                    layer = if let Some(t) = &fx.texture {
                        crate::material::texture_at(
                            &layer,
                            fx.texture_amount(),
                            t,
                            m,
                            true,
                            [n.width / 2., n.height / 2.],
                        )?
                    } else {
                        effects::texture_linear(&layer, fx.amount * fx.opacity * 2., m)?
                    }
                }
                "noise" => {
                    let inverse = m.inverse_composed(r)?;
                    for y in r.y..r.bottom() {
                        for x in r.x..r.right() {
                            let i = r.index(x, y).expect("noise");
                            let p = layer.pixels[i];
                            let density = fx.amount.max(0.01);
                            let q = inverse.point(Point::new(x as f64 + 0.5, y as f64 + 0.5));
                            let v = effects::noise(
                                (q.x * density).floor() as i32,
                                (q.y * density).floor() as i32,
                                7,
                            );
                            layer.pixels[i] = {
                                let source = Pixel::rgba(v, v, v, fx.opacity as f32 * p.0[3]);
                                over(
                                    p,
                                    if self.compatible {
                                        source.rgba8_quantized()
                                    } else {
                                        source
                                    },
                                    "soft-light",
                                )
                            };
                        }
                    }
                }
                "glass" | "background-blur" => {}
                _ => return Err(format!("Unsupported effect {}", fx.kind)),
            }
            if self.compatible {
                layer.quantize_rgba8();
            }
        }
        Ok(Some(layer))
    }
}

#[cfg(test)]
#[path = "renderer_tests/solid_quantization.rs"]
mod solid_quantization_tests;

#[cfg(test)]
#[path = "renderer_tests/memory.rs"]
mod memory_tests;

#[cfg(test)]
#[path = "renderer_tests/gpu_ledger.rs"]
mod gpu_ledger_tests;

#[cfg(test)]
#[path = "renderer_tests/translation_retention.rs"]
mod translation_retention_tests;

#[cfg(test)]
#[path = "renderer_tests/linear_tile_residency.rs"]
mod linear_tile_residency_tests;

#[cfg(test)]
mod image_payload_owner_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn equal_image_payloads_share_storage_without_changing_document_bytes() {
        let uri="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a14cAAAAASUVORK5CYII=";
        let value=json!({"schemaVersion":16,"id":"images","name":"images","pages":[{"id":"p","name":"p","children":["a","b"],"background":"#ffffff"}],"nodes":{
            "a":{"id":"a","kind":"rectangle","width":10,"height":10,"fills":[{"kind":"image","color":"#ffffff","image":uri}]},
            "b":{"id":"b","kind":"rectangle","width":10,"height":10,"fills":[{"kind":"image","color":"#ffffff","image":uri}]}
        }});
        let document:Document=serde_json::from_value(value).unwrap();let before=serde_json::to_vec(&document).unwrap();
        assert_ne!(document.nodes["a"].fills[0].image.as_ref().unwrap().as_ptr(),document.nodes["b"].fills[0].image.as_ref().unwrap().as_ptr());
        let mut engine=Engine::new();engine.install_document(document).unwrap();
        let stored=engine.doc.as_ref().unwrap();
        assert_eq!(stored.nodes["a"].fills[0].image.as_ref().unwrap().as_ptr(),stored.nodes["b"].fills[0].image.as_ref().unwrap().as_ptr());
        assert_eq!(serde_json::to_vec(&**stored).unwrap(),before);
    }
}

#[cfg(all(test,not(target_arch="wasm32")))]
mod source_load_measurement_tests {
    use super::*;
    #[test]
    fn indexed_source_load_keeps_validation_without_granting_an_unmeasured_edit_receipt(){
        let document:Document=serde_json::from_value(serde_json::json!({"schemaVersion":20,"id":"source","name":"source","pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],
            "nodes":{"n":{"id":"n","kind":"rectangle","width":10,"height":20,"fills":[{"kind":"solid","color":"#abcdef"}]}}})).unwrap();
        let mut native=Engine::new();crate::capacity::with_source_storage_scope(true,||native.load_source_document(document.clone())).unwrap();
        assert!(native.source_doc_bytes.is_none());assert!(native.retained_source_size.is_none());
        let mut ordinary=Engine::new();ordinary.load_document(&serde_json::to_string(&document).unwrap()).unwrap();assert!(ordinary.source_doc_bytes.is_some());
        let mut invalid=document.clone();invalid.nodes.get_mut("n").unwrap().width=-1.;
        assert!(crate::capacity::with_source_storage_scope(true,||native.load_source_document(invalid)).is_err());
        assert_eq!(native.source_doc.as_deref(),Some(&document));
    }
}
