//! Native cold-record consumer. The lane owner retains only resource/receipt
//! state until a complete operation is needed. The working Engine is private,
//! revision-owned and replaceable; it never serves edits, history or exports.
use super::*;
use crate::{
    scene::Document,
    scene_store::{Reader, archive::Selection},
};
use std::collections::BTreeSet;

#[derive(Default)]
pub(crate) struct LazyRuntime {
    compiler: Option<Engine>,
    selection: Option<Selection>,
    margin: Option<MarginIndex>,
    properties: Option<PageProperties>,
    padding: Option<(u64, i32)>,
    epoch: u64,
    rebuilds: u64,
    reuses: u64,
    children: Option<Arc<Vec<String>>>,
    children_bytes: usize,
    pub(crate) stats: Value,
}
impl LazyRuntime {
    pub(crate) fn request_key(
        owner: &Engine,
        header: &Document,
        request: &str,
    ) -> Result<Option<[u64; 5]>, String> {
        Ok(Query::parse_with_header(owner, request, Some(header))?
            .filter(|q| !q.options.grid && !q.options.checkerboard)
            .map(|q| {
                [
                    q.options.view.x.to_bits(),
                    q.options.view.y.to_bits(),
                    q.options.view.zoom.to_bits(),
                    q.options.width as u64,
                    q.options.height as u64,
                ]
            }))
    }
    pub(crate) fn stats_json(&self) -> Option<String> {
        self.compiler
            .as_ref()
            .and_then(|c| serde_json::to_string(c.stats()).ok())
    }
    pub(crate) fn clear(&mut self, owner: &mut Engine) {
        if self.compiler.take().is_some() {
            owner.invalidate_frame_scene_request();
        }
        self.selection = None;
        self.margin = None;
        self.properties = None;
        self.padding = None;
        self.children = None;
        self.children_bytes = 0;
        owner.frame_scene.limit_retention(None);
    }
    fn decline(&mut self, reason: &str) -> Result<Option<Vec<u8>>, String> {
        self.stats = json!({"mode":"complete-fallback","reason":reason,"lazy":true,"projectionRebuilds":self.rebuilds,"projectionReuses":self.reuses});
        Ok(None)
    }
    pub(crate) fn compile(
        &mut self,
        owner: &mut Engine,
        reader: &mut Reader,
        header: &Document,
        request: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let Some(query) = Query::parse_with_header(owner, request, Some(header))? else {
            return self.decline("request-contract");
        };
        if query.options.grid || query.options.checkerboard {
            return self.decline("camera-chrome");
        }
        let Some(directory) = reader.directory() else {
            return self.decline(
                reader
                    .archive_fallback_reason()
                    .unwrap_or("archive-index-unavailable"),
            );
        };
        if self.children.is_none() {
            let children = directory.children();
            self.children_bytes = children
                .capacity()
                .saturating_mul(std::mem::size_of::<String>())
                .saturating_add(children.iter().map(String::len).sum::<usize>())
                .saturating_add(128);
            if directory.bytes().saturating_add(self.children_bytes) > CACHE {
                return self.decline("root-directory-budget");
            }
            self.children = Some(Arc::new(children));
        }
        let Some(page) = header
            .pages
            .first()
            .filter(|p| p.id == query.options.page_id)
        else {
            return self.decline("different-page");
        };
        let cancel = AtomicBool::new(false);
        let view = query.options.view;
        let camera = Transform([view.zoom, 0., 0., view.zoom, view.x, view.y]);
        let Some(mut selection) = directory
            .select(camera, query.prepare.expand(4), &cancel)
            .map_err(|e| e.to_string())?
        else {
            return self.decline("global-source-contract");
        };
        let mut expansions = 0;
        loop {
            crate::render_cancellation::checkpoint()?;
            if selection.required_nodes == directory.total_nodes() {
                return self.decline("complete-demand");
            }
            if self.compiler.is_none()
                || self.selection.as_ref().map(|s| &s.units) != Some(&selection.units)
            {
                // Drop the obsolete optional working set before admitting its
                // successor. The visible GPU backing has a separate owner.
                self.compiler = None;
                self.margin = None;
                self.properties = None;
                self.padding = None;
                let mut document = reader
                    .render_metadata(&cancel)
                    .map_err(|e| e.to_string())?
                    .clone();
                if document.id != header.id
                    || document.pages != header.pages
                    || document.schema_version != header.schema_version
                    || document.color_management != header.color_management
                    || document.raster_profile != header.raster_profile
                {
                    return Err("Lazy source header changed".into());
                }
                let roots = directory.selected_roots(&selection);
                let ids = directory.record_ids(&selection);
                let authored: BTreeSet<_> = ids.iter().cloned().collect();
                document.nodes = reader
                    .read_demand(ids, &cancel)
                    .map_err(|e| e.to_string())?;
                let stage = document
                    .nodes
                    .get_mut(directory.stage())
                    .ok_or("Missing source stage")?;
                if stage.children.as_slice() != self.children.as_ref().unwrap().as_slice() {
                    return Err("Lazy stage topology changed".into());
                }
                stage.children = roots.clone();
                self.epoch = self
                    .epoch
                    .checked_add(1)
                    .ok_or("Lazy source epoch exhausted")?;
                let compiler = match owner.resolve_source_projection(document, self.epoch) {
                    Ok(compiler) => compiler,
                    Err(error) => {
                        crate::render_cancellation::checkpoint()?;
                        self.stats = json!({"projectionDecline":error});
                        return self.decline("derivation-contract");
                    }
                };
                let resolved = compiler
                    .doc
                    .as_ref()
                    .ok_or("Missing resolved lazy source")?;
                // A generated glyph ID cannot borrow a cold authored identity.
                // The complete resolver owns any such collision semantics.
                if resolved
                    .nodes
                    .keys()
                    .any(|id| !authored.contains(id) && directory.contains(id))
                    || resolved
                        .nodes
                        .get(directory.stage())
                        .is_none_or(|stage| stage.children != roots)
                {
                    return self.decline("derived-namespace");
                }
                let properties = PageProperties::build(resolved, &page.children)
                    .with_cold_ordinary(selection.cold_nodes, selection.cold_solid);
                if properties.has_zoom() {
                    return self.decline("radial-read-domain");
                }
                owner.frame_scene.limit_retention(Some(0));
                let Some(margin) = MarginIndex::build(
                    resolved,
                    &page.children,
                    CACHE
                        .saturating_sub(directory.bytes())
                        .saturating_sub(self.children_bytes),
                )?
                else {
                    return self.decline("context-budget");
                };
                self.compiler = Some(compiler);
                self.margin = Some(margin);
                self.properties = Some(properties);
                self.selection = Some(selection.clone());
                self.rebuilds += 1;
                owner.invalidate_frame_scene_request();
            } else {
                self.reuses += 1;
            }
            let compiler = self.compiler.as_mut().unwrap();
            let margin = self.margin.as_ref().unwrap();
            let padding = if let Some((_, padding)) = self
                .padding
                .filter(|(zoom, _)| *zoom == view.zoom.to_bits())
            {
                padding
            } else {
                let Some(padding) = margin.padding(compiler.doc.as_ref().unwrap(), camera)? else {
                    return self.decline("margin-scratch");
                };
                self.padding = Some((view.zoom.to_bits(), padding));
                padding
            };
            if !(0..=16_000_000).contains(&padding) {
                return self.decline("effect-coordinate-domain");
            }
            let reserved = directory
                .bytes()
                .saturating_add(self.children_bytes)
                .saturating_add(margin.bytes());
            if reserved > CACHE {
                return self.decline("context-budget");
            }
            owner.frame_scene.limit_retention(Some(CACHE - reserved));
            compiler.source_compile_context = Some(SourceCompileContext {
                page: page.id.clone(),
                camera: (view.x, view.y, view.zoom),
                properties: self.properties.unwrap(),
                padding,
                backdrop: crate::fidelity::has_backdrop(
                    compiler.doc.as_ref().unwrap(),
                    &query.options,
                ),
                stage: directory.stage().into(),
                stage_children: self.children.as_ref().unwrap().clone(),
                reserved_bytes: reserved,
                // Unknown cold paint is not authority to fill uncovered gaps.
                // Normal tile coverage remains responsible for presentation.
                page_paint_rects: None,
            });
            let mut expanded = None;
            std::mem::swap(&mut compiler.frame_scene, &mut owner.frame_scene);
            let result = compiler.compile_gpu_packet_request_checked(request, |scene| {
                let next = directory
                    .select(camera, query.prepare.union(scene.extent).expand(4), &cancel)
                    .map_err(|e| e.to_string())?
                    .ok_or("SOURCE_DEMAND_REPLAN")?;
                if next
                    .units
                    .iter()
                    .any(|unit| selection.units.binary_search(unit).is_err())
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
                    return self.decline("scope-convergence");
                }
                selection = next;
                continue;
            }
            self.stats = json!({"mode":"mapped-demand","lazy":true,"sourceNodes":directory.total_nodes(),"residentAuthoredNodes":selection.required_nodes,
                "coldNodes":directory.total_nodes().saturating_sub(selection.required_nodes),"resolvedCompileNodes":compiler.doc.as_ref().unwrap().nodes.len(),
                "indexMappedBytes":directory.mapped_bytes(),"indexResidentBytes":directory.bytes(),"rootDirectoryBytes":self.children_bytes,"globalPadding":padding,"contextMarginBytes":margin.bytes(),"scopeExpansions":expansions,
                "projectionRebuilds":self.rebuilds,"projectionReuses":self.reuses,"cache":cache});
            // Compiler failures retain the exact complete path. Cancellation
            // still propagates and never starts a second obsolete full render.
            match result {
                Ok(bytes) => return Ok(Some(bytes)),
                Err(_) => {
                    crate::render_cancellation::checkpoint()?;
                    return self.decline("compile-contract");
                }
            }
        }
    }
}
