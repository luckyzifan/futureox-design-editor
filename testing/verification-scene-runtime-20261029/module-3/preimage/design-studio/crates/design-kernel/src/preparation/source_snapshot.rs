//! Only the desktop host may resolve an opaque source capability to this
//! descriptor. The complete consumer remains explicit while viewport readers
//! acquire records through scene_demand without a giant JSON intermediate.
use crate::{scene::Document, scene_store};
use serde::Deserialize;
use std::{path::PathBuf, sync::atomic::AtomicBool};

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
#[derive(Clone)]
pub(super) struct Access {
    descriptor: Descriptor,
    catalog: Option<std::sync::Arc<crate::scene_demand::Catalog>>,
}
impl Access {
    pub(super) fn viewport(
        &mut self,
        fonts: &crate::font::Fonts,
        camera: crate::math::Transform,
        viewport: crate::math::Rect,
        cancel: &AtomicBool,
    ) -> Result<crate::scene_demand::LoadedDemand, String> {
        let d = &self.descriptor;
        if self.catalog.is_none() {
            self.catalog = Some(crate::scene_demand::Catalog::open(
                &d.path,
                &d.store,
                &d.stage_id,
                fonts,
                cancel,
            )?);
        }
        self.catalog
            .as_ref()
            .unwrap()
            .viewport(camera, viewport, cancel)?
            .load(&d.path, &d.store, cancel)
    }
}
pub(super) fn read(value: &serde_json::Value) -> Result<(Document, Access), String> {
    let descriptor: Descriptor =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid source snapshot descriptor")?;
    if !descriptor.path.is_absolute()
        || descriptor.store.document_id != descriptor.document_id
        || descriptor.store.nodes != descriptor.nodes as u64
    {
        return Err("Invalid source snapshot descriptor".into());
    }
    let metadata = std::fs::symlink_metadata(&descriptor.path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() != descriptor.store.bytes {
        return Err("Source snapshot file changed".into());
    }
    let cancel = AtomicBool::new(false);
    let (doc, _) = scene_store::Reader::open(&descriptor.path, &descriptor.store, &cancel)
        .and_then(|reader| reader.into_document(&cancel))
        .map_err(|e| e.to_string())?;
    if doc.id != descriptor.document_id
        || doc.nodes.len() != descriptor.nodes
        || doc.pages.first().is_none_or(|page| {
            page.id != descriptor.page_id || page.children != [descriptor.stage_id.clone()]
        })
        || doc
            .nodes
            .get(&descriptor.stage_id)
            .is_none_or(|node| node.kind != "frame")
    {
        return Err("Source snapshot canvas identity changed".into());
    }
    Ok((
        doc,
        Access {
            descriptor,
            catalog: None,
        },
    ))
}
