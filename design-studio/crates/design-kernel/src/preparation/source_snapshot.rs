//! An immutable source capability, distinct from a complete editable Engine.
//! Mapped snapshots start with a small header and cold records. The native
//! boundary explicitly materializes before edits/exports/unknown plans.
use crate::{scene::Document, scene_store};
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    path: PathBuf,
    store: scene_store::Descriptor,
    document_id: String,
    page_id: String,
    stage_id: String,
    nodes: usize,
}
pub(super) struct Access {
    descriptor: Descriptor,
    header: Arc<Document>,
    reader: Option<Arc<Mutex<scene_store::Reader>>>,
    complete: bool,
    forkable: bool,
    can_reduce: bool,
    last_full_view: Option<[u64; 5]>,
    catalog: Option<((u64, bool, bool), Arc<crate::scene_demand::Catalog>)>,
    runtime: crate::source_compile::Runtime,
    #[cfg(feature = "mapped-source-snapshot")]
    lazy: crate::source_compile::LazyRuntime,
    fallback: Option<serde_json::Value>,
}
impl Clone for Access {
    fn clone(&self) -> Self {
        Self {
            descriptor: self.descriptor.clone(),
            header: self.header.clone(),
            reader: self.reader.clone(),
            complete: self.complete,
            forkable: self.forkable,
            can_reduce: self.can_reduce,
            last_full_view: self.last_full_view,
            catalog: self.catalog.clone(),
            runtime: Default::default(),
            #[cfg(feature = "mapped-source-snapshot")]
            lazy: Default::default(),
            fallback: self.fallback.clone(),
        }
    }
}
fn check(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("Source acquisition cancelled".into());
    }
    crate::render_cancellation::checkpoint()
}
impl Access {
    pub(super) fn pick_engine<'a>(&'a self,owner:&'a crate::Engine)->Option<&'a crate::Engine>{
        if self.complete {return Some(owner)}
        #[cfg(feature="mapped-source-snapshot")]
        {return self.lazy.pick_engine()}
        #[cfg(not(feature="mapped-source-snapshot"))]
        None
    }
    pub(super) fn is_lazy(&self) -> bool {
        !self.complete
    }
    pub(super) fn can_fork_lazy(&self) -> bool {
        !self.complete && self.forkable
    }
    pub(super) fn settings(&self) -> Option<crate::color::ColorSettings> {
        self.header.color_management
    }
    pub(super) fn summary(&self) -> serde_json::Value {
        serde_json::json!({"documentId":self.descriptor.document_id,"pageId":self.descriptor.page_id,
        "stageId":self.descriptor.stage_id,"nodes":self.descriptor.nodes})
    }
    pub(super) fn stats_json(&self) -> Option<String> {
        #[cfg(feature = "mapped-source-snapshot")]
        if !self.complete {
            return self.lazy.stats_json();
        }
        None
    }
    pub(super) fn ensure_complete(
        &mut self,
        owner: &mut crate::Engine,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        if self.complete {
            return Ok(());
        }
        check(cancel)?;
        #[cfg(feature = "mapped-source-snapshot")]
        self.lazy.clear(owner);
        let document = {
            let reader = self.reader.as_ref().ok_or("Missing cold source reader")?;
            let mut reader = reader.lock().map_err(|_| "Source reader lock poisoned")?;
            reader.release_directory();
            reader
                .complete_document(cancel)
                .map_err(|e| e.to_string())?
        };
        validate_complete(&document, &self.descriptor)?;
        check(cancel)?;
        // Install only after full authenticated acquisition. A failed/cancelled
        // read cannot publish a partial authoritative model or a new receipt.
        crate::capacity::with_source_storage_scope(true, || owner.load_source_document(document))?;
        self.complete = true;
        self.catalog = None;
        self.runtime = Default::default();
        Ok(())
    }
    pub(super) fn compile(
        &mut self,
        owner: &mut crate::Engine,
        request: &str,
    ) -> Result<Vec<u8>, String> {
        #[cfg(feature = "mapped-source-snapshot")]
        {
            let enabled = (!self.complete || self.can_reduce)
                && std::env::var("CORE_SOURCE_LAZY_LOAD").as_deref() != Ok("0");
            let key = if enabled {
                crate::source_compile::LazyRuntime::request_key(owner, &self.header, request)?
            } else {
                None
            };
            let attempt = enabled
                && (!self.complete
                    || self.can_reduce && key.is_some() && key != self.last_full_view);
            if attempt {
                let was_complete = self.complete;
                if was_complete {
                    // A new camera may shrink a prior full-view working set.
                    // Reclaim optional caches before remapping the directory;
                    // retain full authority until a lazy packet succeeds.
                    self.runtime = Default::default();
                    self.catalog = None;
                    owner.release_source_compile_caches();
                    owner.frame_scene.limit_retention(Some(0));
                }
                let result = (|| {
                    let reader = self.reader.as_ref().ok_or("Missing cold source reader")?;
                    let mut reader = reader.lock().map_err(|_| "Source reader lock poisoned")?;
                    reader
                        .reload_directory(&AtomicBool::new(false))
                        .map_err(|e| e.to_string())?;
                    self.lazy.compile(owner, &mut reader, &self.header, request)
                })();
                match result {
                    Ok(Some(bytes)) => {
                        if was_complete {
                            owner.park_source_authority();
                        }
                        self.complete = false;
                        self.last_full_view = None;
                        return Ok(bytes);
                    }
                    Ok(None) => self.fallback = Some(self.lazy.stats.clone()),
                    Err(error) => {
                        if !was_complete {
                            return Err(error);
                        }
                        crate::render_cancellation::checkpoint()?;
                        self.fallback = Some(
                            serde_json::json!({"mode":"complete-fallback","reason":"lazy-acquisition-declined","detail":error}),
                        );
                    }
                }
                self.lazy.clear(owner);
                if let Some(reader) = &self.reader {
                    reader
                        .lock()
                        .map_err(|_| "Source reader lock poisoned")?
                        .release_directory();
                }
            }
            self.last_full_view = key;
        }
        self.ensure_complete(owner, &AtomicBool::new(false))?;
        self.runtime.compile(
            owner,
            &self.descriptor.store,
            &self.descriptor.stage_id,
            &self.descriptor.page_id,
            request,
        )
    }
    pub(super) fn compile_stats(&self) -> serde_json::Value {
        #[cfg(feature = "mapped-source-snapshot")]
        if !self.complete {
            return self.lazy.stats.clone();
        }
        let mut stats = self.runtime.stats.clone();
        if let (Some(fallback), Some(object)) = (&self.fallback, stats.as_object_mut()) {
            object.insert("lazyFallback".into(), fallback.clone());
        }
        stats
    }
    pub(super) fn viewport(
        &mut self,
        owner: &mut crate::Engine,
        camera: crate::math::Transform,
        viewport: crate::math::Rect,
        cancel: &AtomicBool,
    ) -> Result<crate::scene_demand::LoadedDemand, String> {
        check(cancel)?;
        #[cfg(feature = "mapped-source-snapshot")]
        if !self.complete {
            let result = {
                let mut reader = self
                    .reader
                    .as_ref()
                    .ok_or("Missing cold source reader")?
                    .lock()
                    .map_err(|_| "Source reader lock poisoned")?;
                reader.reload_directory(cancel).map_err(|e| e.to_string())?;
                if let Some(directory) = reader.directory() {
                    if let Some(selection) = directory
                        .select_authored(camera, viewport, cancel)
                        .map_err(|e| e.to_string())?
                    {
                        let before = reader.stats();
                        let nodes = reader
                            .read_demand(directory.record_ids(&selection), cancel)
                            .map_err(|e| e.to_string())?;
                        Some(crate::scene_demand::LoadedDemand::mapped(
                            directory,
                            &selection,
                            nodes,
                            reader.stats().since(before),
                        ))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            if let Some(result) = result {
                return Ok(result);
            }
        }
        self.ensure_complete(owner, cancel)?;
        crate::capacity::with_source_storage_scope(true, || owner.resolve_layout())?;
        let d = &self.descriptor;
        let catalog = if let Some(key) = owner.static_scene_revision() {
            if self.catalog.as_ref().is_none_or(|(old, _)| *old != key) {
                self.catalog = None;
                self.catalog = Some((
                    key,
                    crate::scene_demand::Catalog::from_engine(
                        owner,
                        &d.store,
                        &d.stage_id,
                        cancel,
                        64 * 1024 * 1024,
                    )?,
                ));
            }
            self.catalog.as_ref().unwrap().1.clone()
        } else {
            self.catalog = None;
            crate::scene_demand::Catalog::open(
                &d.path,
                &d.store,
                &d.stage_id,
                &owner.fonts,
                cancel,
            )?
        };
        catalog
            .viewport(camera, viewport, cancel)?
            .load(&d.path, &d.store, cancel)
    }
}
fn validate_header(document: &Document, d: &Descriptor) -> Result<(), String> {
    if document.id != d.document_id
        || document
            .pages
            .first()
            .is_none_or(|page| page.id != d.page_id || page.children != [d.stage_id.clone()])
    {
        return Err("Source snapshot canvas identity changed".into());
    }
    Ok(())
}
fn validate_complete(document: &Document, d: &Descriptor) -> Result<(), String> {
    validate_header(document, d)?;
    if document.nodes.len() != d.nodes
        || document
            .nodes
            .get(&d.stage_id)
            .is_none_or(|n| n.kind != "frame")
    {
        return Err("Source snapshot canvas identity changed".into());
    }
    Ok(())
}
fn small_header(document: &Document) -> Document {
    Document {
        fd_compatibility: None,
        reviews: vec![],
        design_system: None,
        prototype: None,
        schema_version: document.schema_version,
        color_management: document.color_management,
        raster_profile: document.raster_profile,
        id: document.id.clone(),
        name: document.name.clone(),
        pages: document.pages.clone(),
        nodes: Default::default(),
        fonts: Default::default(),
        animations: vec![],
    }
}
pub(super) fn read(value: &serde_json::Value) -> Result<(Option<Document>, Access), String> {
    let descriptor: Descriptor =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid source snapshot descriptor")?;
    if !descriptor.path.is_absolute()
        || descriptor.store.document_id != descriptor.document_id
        || descriptor.store.nodes != descriptor.nodes as u64
    {
        return Err("Invalid source snapshot descriptor".into());
    }
    let cancel = AtomicBool::new(false);
    let mut reader = scene_store::Reader::open(&descriptor.path, &descriptor.store, &cancel)
        .map_err(|e| e.to_string())?;
    let lazy = cfg!(feature = "mapped-source-snapshot")
        && reader.is_mapped_format()
        && std::env::var("CORE_SOURCE_LAZY_LOAD").as_deref() != Ok("0");
    #[cfg(feature = "mapped-source-snapshot")]
    let (forkable, can_reduce) = if lazy {
        reader
            .directory()
            .map(|d| (d.eligible(), d.can_reduce()))
            .unwrap_or_default()
    } else {
        (false, false)
    };
    #[cfg(not(feature = "mapped-source-snapshot"))]
    let (forkable, can_reduce) = (false, false);
    let (document, header, reader) = if lazy {
        #[cfg(feature = "mapped-source-snapshot")]
        let mapped_header = reader
            .directory()
            .map(|d| d.header())
            .transpose()
            .map_err(|e| e.to_string())?;
        #[cfg(not(feature = "mapped-source-snapshot"))]
        let mapped_header: Option<Document> = None;
        let header = match mapped_header {
            Some(header) => header,
            None => small_header(reader.metadata(&cancel).map_err(|e| e.to_string())?),
        };
        validate_header(&header, &descriptor)?;
        if reader
            .read_node(&descriptor.stage_id, &cancel)
            .map_err(|e| e.to_string())?
            .is_none_or(|n| n.kind != "frame")
        {
            return Err("Source snapshot stage changed".into());
        }
        reader.clear_payload_cache();
        (None, header, Some(Arc::new(Mutex::new(reader))))
    } else {
        let (document, _) = reader.into_document(&cancel).map_err(|e| e.to_string())?;
        validate_complete(&document, &descriptor)?;
        let header = small_header(&document);
        (Some(document), header, None)
    };
    Ok((
        document,
        Access {
            descriptor,
            header: Arc::new(header),
            reader,
            complete: !lazy,
            forkable,
            can_reduce,
            last_full_view: None,
            catalog: None,
            runtime: Default::default(),
            #[cfg(feature = "mapped-source-snapshot")]
            lazy: Default::default(),
            fallback: None,
        },
    ))
}
