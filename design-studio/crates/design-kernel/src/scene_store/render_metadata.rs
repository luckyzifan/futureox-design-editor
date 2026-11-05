//! Render-only projection of authenticated metadata. Foreign round-trip blobs,
//! reviews and provenance remain cold; the complete prefix retains them for
//! edits and export. Styles/variables/fonts remain full semantic dependencies.
use super::*;
use crate::design_system::{Collection, DesignSystem, LibraryVersion, SharedStyle, Variable};
#[derive(Deserialize)]
pub(super) struct RenderMetadata {
    pub generation: String,
    document: RenderDocument,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderDocument {
    schema_version: u32,
    id: String,
    name: String,
    pages: Vec<crate::scene::Page>,
    #[serde(default)]
    color_management: Option<crate::color::ColorSettings>,
    #[serde(default)]
    raster_profile: Option<crate::fidelity::RasterProfile>,
    #[serde(default)]
    fonts: BTreeMap<String, crate::font::FontResource>,
    #[serde(default)]
    design_system: Option<RenderDesignSystem>,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RenderDesignSystem {
    collections: BTreeMap<String, Collection>,
    variables: BTreeMap<String, Variable>,
    active_modes: BTreeMap<String, String>,
    styles: BTreeMap<String, SharedStyle>,
    libraries: BTreeMap<String, LibraryVersion>,
}
impl RenderMetadata {
    pub(super) fn document(self) -> Document {
        let d = self.document;
        Document {
            fd_compatibility: None,
            reviews: vec![],
            prototype: None,
            animations: vec![],
            nodes: Default::default(),
            schema_version: d.schema_version,
            id: d.id,
            name: d.name,
            pages: d.pages,
            color_management: d.color_management,
            raster_profile: d.raster_profile,
            fonts: d.fonts,
            design_system: d.design_system.map(|s| DesignSystem {
                font_sources: BTreeMap::new(),
                sketch_containers: BTreeMap::new(),
                collections: s.collections,
                variables: s.variables,
                active_modes: s.active_modes,
                styles: s.styles,
                libraries: s.libraries,
            }),
        }
    }
}
