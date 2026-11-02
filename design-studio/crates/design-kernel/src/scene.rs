use crate::{
    math::{Point, Transform},
    path::{Command, Path, area},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const MAX_GRADIENT_STOPS: usize = 64;

fn yes() -> bool {
    true
}
fn one() -> f64 {
    1.
}
fn is_zero(value: &f64) -> bool {
    *value == 0.
}
fn six() -> usize {
    6
}
fn half() -> f64 {
    0.45
}
fn font_size() -> f64 {
    28.
}
fn normal() -> String {
    "normal".into()
}
fn evenodd() -> String {
    "evenodd".into()
}
fn center() -> String {
    "center".into()
}
fn round() -> String {
    "round".into()
}
fn cover() -> String {
    "cover".into()
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fd_compatibility: Option<crate::fd_extensions::FdCompatibility>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reviews: Vec<crate::reviews::Review>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_system: Option<crate::design_system::DesignSystem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prototype: Option<crate::prototype::Prototype>,
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_management: Option<crate::color::ColorSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raster_profile: Option<crate::fidelity::RasterProfile>,
    pub id: String,
    pub name: String,
    pub pages: Vec<Page>,
    pub nodes: BTreeMap<String, Node>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fonts: BTreeMap<String, crate::font::FontResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub animations: Vec<crate::animation::Clip>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Page {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guides: Vec<RulerGuide>,
    pub id: String,
    pub name: String,
    pub children: Vec<String>,
    pub background: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RulerGuide {
    pub id: String,
    pub axis: String,
    pub position: f64,
}
fn validate_guides(guides: &[RulerGuide], version: u32) -> Result<(), String> {
    if guides.len() > 1000 || (!guides.is_empty() && version < 11) {
        return Err("Ruler guides require schema 11 and at most 1000 per owner".into());
    }
    let mut ids = HashSet::new();
    for g in guides {
        if g.id.is_empty()
            || g.id.len() > 128
            || !ids.insert(&g.id)
            || !matches!(g.axis.as_str(), "x" | "y")
            || !g.position.is_finite()
            || g.position.abs() > 1e7
        {
            return Err("Invalid ruler guide".into());
        }
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EllipseArc {
    pub start_angle: f64,
    pub sweep_angle: f64,
    pub inner_radius: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSetting {
    pub id: String,
    pub format: String,
    pub scale: f64,
    pub suffix: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardContent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u32>,
}
/// Authored layout grid overlay on a frame (Sketch `grid`/`layout` dicts,
/// Figma `layoutGrids`). Track sizes derive from the frame extent:
/// `(extent - 2*margin - (count-1)*gutter) / count`, so "uniform" yields
/// square cells. The axis/count model follows the Figma REST shape; the
/// archived Sketch fields map onto it in `interop.rs`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutGrid {
    pub axis: String,
    pub count: u32,
    #[serde(default)]
    pub gutter: f64,
    #[serde(default)]
    pub margin: f64,
    pub color: String,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default = "one")]
    pub opacity: f64,
}
impl LayoutGrid {
    pub fn validate(&self, management: Option<&crate::color::ColorSettings>) -> Result<(), String> {
        if !matches!(self.axis.as_str(), "column" | "row" | "uniform")
            || !(1..=64).contains(&self.count)
            || !self.gutter.is_finite()
            || self.gutter < 0.
            || self.gutter > 1e7
            || !self.margin.is_finite()
            || self.margin < 0.
            || self.margin > 1e7
            || !self.opacity.is_finite()
            || !(0. ..=1.).contains(&self.opacity)
        {
            return Err("Invalid layout grid parameters".into());
        }
        crate::color::pixel(management.copied(), &self.color, 1.)?;
        Ok(())
    }
    /// Lit track extents along one axis given the frame extent. Uniform
    /// grids use the derived square cell size on both axes.
    pub fn tracks(&self, extent: f64) -> Vec<f64> {
        let count = self.count.max(1) as usize;
        let track = ((extent - 2. * self.margin - (count as f64 - 1.) * self.gutter)
            / count as f64)
            .max(0.);
        let mut tracks = Vec::with_capacity(count * 2);
        for i in 0..count {
            if i > 0 {
                tracks.push(self.gutter);
            }
            tracks.push(track);
        }
        tracks
    }
}
// Only cold, usually empty collections use this candidate. Hot paints,
// children, paths and transfer buffers retain their existing representation.
#[cfg(feature="compact-node-vectors")]
pub type ColdNodeVec<T> = thin_vec::ThinVec<T>;
#[cfg(not(feature="compact-node-vectors"))]
pub type ColdNodeVec<T> = Vec<T>;
fn cold_node_vec_is_empty<T>(values:&ColdNodeVec<T>)->bool {values.is_empty()}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Box<crate::repeat::Repeat>>,
    /// Disposable render-scene selection ownership; never authored or serialized.
    #[serde(skip)]
    pub(crate) repeat_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector_brush: Option<Box<crate::vector_brush::VectorBrush>>,
    #[serde(default, skip_serializing_if = "cold_node_vec_is_empty")]
    pub guides: ColdNodeVec<RulerGuide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_path: Option<Box<crate::text_path::TextPath>>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub path_offset: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector: Option<Box<crate::connectors::Connector>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<Box<BoardContent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_grid: Option<Box<LayoutGrid>>,
    #[serde(default, skip_serializing_if = "cold_node_vec_is_empty")]
    pub export_settings: ColdNodeVec<ExportSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc: Option<EllipseArc>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub corner_radius: f64,
    #[serde(default, skip_serializing_if = "crate::components::is_false")]
    pub constrain_proportions: bool,
    /// Renderer-only glyph outlines; never serialized into authored documents.
    #[serde(skip)]
    pub(crate) derived_path: Option<std::sync::Arc<Path>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boolean_operation: Option<crate::boolean::Operation>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub bindings: BTreeMap<String, String>,
    /// Authored collection selections; absent collections inherit their nearest ancestor.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub variable_modes: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub style_refs: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask_type: Option<String>,
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub transform: Transform,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub children: Vec<String>,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default = "normal")]
    pub blend: String,
    #[serde(default)]
    pub fills: Vec<Paint>,
    #[serde(default)]
    pub strokes: Vec<Stroke>,
    #[serde(default)]
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub radii: [f64; 4],
    #[serde(default)]
    pub smoothing: f64,
    #[serde(default)]
    pub clip: bool,
    #[serde(default)]
    pub mask: bool,
    #[serde(default = "six")]
    pub points: usize,
    #[serde(default = "half")]
    pub inner_radius: f64,
    #[serde(default)]
    pub network: Option<std::sync::Arc<Network>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector_geometry: Option<std::sync::Arc<crate::vector_geometry::VectorGeometry>>,
    #[serde(default)]
    pub text: String,
    #[serde(default = "font_size")]
    pub font_size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_style: Option<Box<crate::font::TextStyle>>,
    #[serde(default, skip_serializing_if = "cold_node_vec_is_empty")]
    pub text_runs: ColdNodeVec<crate::font::TextRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<crate::layout::Layout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizing: Option<crate::layout::Sizing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<crate::layout::Constraints>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<Box<crate::components::Component>>,
    #[serde(default, skip_serializing_if = "crate::components::is_false")]
    pub component_set: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<Box<crate::components::Instance>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_origin: Option<Box<crate::components::Origin>>,
}
impl Node {
    /// Freeze owned large-element vectors before publishing an immutable
    /// snapshot. Do this per node while loading/adopting, never by rebuilding
    /// the whole map or shrinking/growing every pointer-frame draft.
    pub(crate) fn compact_storage(&mut self) {
        if self.fills.capacity() > self.fills.len() { self.fills.shrink_to_fit(); }
        if self.strokes.capacity() > self.strokes.len() { self.strokes.shrink_to_fit(); }
        if self.effects.capacity() > self.effects.len() { self.effects.shrink_to_fit(); }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Paint {
    /// Maps unit paint coordinates into normalized node coordinates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Transform>,
    #[serde(default)]
    pub id: String,
    pub kind: String,
    pub color: String,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub angle: f64,
    #[serde(default)]
    pub stops: Vec<Stop>,
    #[serde(default)]
    /// Immutable image payloads are shared by authored/resolved snapshots.
    /// Replacing a paint replaces this owner; JSON/FD still contain the exact
    /// original string. No lossy interning or resource identity substitution.
    pub image: Option<std::sync::Arc<str>>,
    #[serde(default = "cover")]
    pub fit: String,
    #[serde(default = "normal")]
    pub blend: String,
    /// Image adjustments (exposure/contrast/…) on image paints; absent is the
    /// identity so pre-schema-13 documents render unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjust: Option<crate::image_adjust::ImageAdjust>,
    /// Pattern tiling on image paints; absent keeps the
    /// single-placement image semantics of pre-schema-14 documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<crate::pattern_fill::PatternTile>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Stop {
    pub offset: f64,
    pub color: String,
}
impl Paint {
    /// A spatially constant paint can blend its original opacity directly.
    /// Keep gradient parsing/transform validation before using this shortcut.
    pub fn constant_color(&self) -> Option<&str> {
        if self.kind == "solid" {
            return Some(&self.color);
        }
        if !matches!(
            self.kind.as_str(),
            "linear" | "radial" | "angular" | "diamond"
        ) {
            return None;
        }
        let first = self.stops.first()?;
        self.stops
            .iter()
            .all(|s| s.color == first.color)
            .then_some(first.color.as_str())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    #[serde(default, skip_serializing_if = "crate::stroke::Marker::is_none")]
    pub start_marker: crate::stroke::Marker,
    #[serde(default, skip_serializing_if = "crate::stroke::Marker::is_none")]
    pub end_marker: crate::stroke::Marker,
    #[serde(default)]
    pub id: String,
    pub paint: Paint,
    pub width: f64,
    #[serde(default = "center")]
    pub align: String,
    #[serde(default = "round")]
    pub cap: String,
    #[serde(default = "round")]
    pub join: String,
    #[serde(default)]
    pub dash: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub dash_offset: f64,
    #[serde(default = "yes")]
    pub visible: bool,
    /// Multipliers of half the base width, at normalized local arc lengths.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub width_profile: Vec<crate::stroke::WidthPoint>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Effect {
    #[serde(default, rename="zoomBlur", skip_serializing_if="Option::is_none")]
    pub zoom_blur: Option<crate::zoom_blur::ZoomBlur>,
    #[serde(default, rename="motionAngle", skip_serializing_if="is_zero")]
    pub motion_angle: f64,
    #[serde(default, rename = "colorControls", skip_serializing_if = "Option::is_none")]
    pub color_controls: Option<crate::color_controls::ColorControls>,
    #[serde(default)]
    pub id: String,
    pub kind: String,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub radius: f64,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub spread: f64,
    pub color: String,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default)]
    pub amount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glass: Option<GlassParameters>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture: Option<TextureParameters>,
    /// Gradient-modulated blur: strength ramps between two node-space
    /// anchors; the blurred and sharp layers blend per pixel by the
    /// decoded two-tier weight curves.
    #[serde(
        default,
        rename = "gradientBlur",
        skip_serializing_if = "Option::is_none"
    )]
    pub gradient_blur: Option<GradientBlurParameters>,
    /// kiwi `Effect.showShadowBehindNode` (ordinal 8): the drop shadow also
    /// draws behind the node's own pixels instead of being clipped to the
    /// silhouette. Carried verbatim from FIG; the renderer's shadow clip
    /// behavior follows the existing effect kinds and does not branch on
    /// this flag yet.
    #[serde(
        default,
        rename = "showShadowBehindNode",
        skip_serializing_if = "crate::components::is_false"
    )]
    pub show_shadow_behind_node: bool,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GradientBlurParameters {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub start_count: f64,
    pub end_count: f64,
    #[serde(default)]
    pub smooth: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlassParameters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bevel_size: Option<f64>,
    pub depth: f64,
    pub refraction: f64,
    pub dispersion: f64,
    pub light_angle: f64,
    pub light_intensity: f64,
}
impl GlassParameters {
    pub fn bevel_size(&self) -> f64 {
        self.bevel_size.unwrap_or(1.)
    }
    /// Figma's authored dispersion is scaled in the render-parameter getter.
    /// Keep the saved/UI value intact and round both shader input stages.
    pub fn chromatic_aberration(&self) -> f32 {
        (self.dispersion as f32) * 0.2_f32
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextureParameters {
    pub noise_size: [f64; 2],
    pub clip_to_shape: bool,
    /// Default/reference field is the recovered GRAIN shader numeric program.
    /// Gabor and SVG Perlin are explicit optional authored materials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noise: Option<String>,
}
impl Effect {
    pub fn blur_radius(&self) -> f64 {
        self.radius
            * self
                .gradient_blur
                .as_ref()
                .map(|g| g.start_count.max(g.end_count).max(1.))
                .unwrap_or(1.)
    }
    pub fn validate_material(&self) -> Result<(), String> {
        if (self.kind=="zoom-blur") != self.zoom_blur.is_some() || self.zoom_blur.is_some_and(|p|!p.validate()
            || self.radius!=0. || self.color_controls.is_some() || self.glass.is_some() || self.texture.is_some() || self.gradient_blur.is_some()) {
            return Err("Invalid zoom blur parameters".into());
        }
        if !self.motion_angle.is_finite() || self.motion_angle.abs()>1e7 || (self.motion_angle!=0. && self.kind!="motion-blur") {
            return Err("Invalid motion blur angle".into());
        }

        if self.kind == "color-controls" && self.color_controls.is_none() { return Err("Color controls parameters required".into()); }
        if let Some(c) = &self.color_controls
            && (!matches!(self.kind.as_str(), "color-controls" | "background-blur") || !c.validate()
                || self.glass.is_some() || self.texture.is_some() || self.gradient_blur.is_some()) {
            return Err("Invalid color controls".into());
        }
        if let Some(g) = &self.gradient_blur
            && (self.kind != "blur"
                || self.glass.is_some()
                || self.texture.is_some()
                || g.start
                    .iter()
                    .chain(g.end.iter())
                    .any(|v| !v.is_finite() || v.abs() > 1e7)
                || [g.start_count, g.end_count]
                    .iter()
                    .any(|v| !v.is_finite() || !(0. ..=64.).contains(v)))
        {
            return Err("Invalid gradient blur parameters".into());
        }
        if let Some(g) = &self.glass
            && (self.kind != "glass"
                || self.texture.is_some()
                || g.bevel_size
                    .is_some_and(|b| !b.is_finite() || !(0.001..=1000.).contains(&b))
                || !g.depth.is_finite()
                || !(1. ..=1000.).contains(&g.depth)
                || !g.light_angle.is_finite()
                || g.light_angle.abs() > 1e7
                || [g.refraction, g.dispersion, g.light_intensity]
                    .iter()
                    .any(|v| !v.is_finite() || !(0. ..=1.).contains(v)))
        {
            return Err("Invalid glass parameters".into());
        }
        if let Some(t) = &self.texture
            && (self.kind != "texture"
                || self.glass.is_some()
                || t.noise_size
                    .iter()
                    .any(|v| !v.is_finite() || !(0.001..=10000.).contains(v))
                || t.noise
                    .as_deref()
                    .is_some_and(|n| !matches!(n, "figma" | "gabor" | "perlin")))
        {
            return Err("Invalid texture parameters".into());
        }
        Ok(())
    }
    pub fn material_halo(&self) -> f64 {
        if let Some(g) = &self.glass {
            // The distance-field neighbourhood must include the whole bevel,
            // even with zero refraction (lighting/dispersion still use it).
            return g.depth.max(g.bevel_size()) * (1. + (g.refraction + g.dispersion * 0.125) * 2.);
        }
        if self.texture.is_some() {
            return self.radius * 2.;
        }
        if matches!(self.kind.as_str(), "texture" | "glass") {
            self.amount.abs() * 2.
        } else {
            0.
        }
    }
    pub fn texture_amount(&self) -> f64 {
        if self.texture.is_some() {
            self.radius * 2.
        } else {
            self.amount * self.opacity * 2.
        }
    }
    pub fn glass_active(&self) -> bool {
        self.glass
            .as_ref()
            .map_or(self.amount != 0. || self.opacity != 0., |g| {
                g.refraction != 0. || g.dispersion != 0. || g.light_intensity != 0.
            })
    }
    /// The authored glass frost control retains zero in the document, but
    /// its backdrop capture has a one-unit minimum filter support.
    pub fn backdrop_radius(&self) -> f64 {
        if self.kind == "glass" && self.glass.is_some() {
            self.radius.max(1.)
        } else {
            self.radius
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Vertex {
    pub id: String,
    pub x: f64,
    pub y: f64,
}
impl Vertex {
    pub(crate) fn point(&self) -> Point {
        Point::new(self.x, self.y)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub c1: Option<Point>,
    #[serde(default)]
    pub c2: Option<Point>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filled_faces: Option<Vec<Vec<String>>>,
    pub vertices: Vec<Vertex>,
    pub edges: Vec<Edge>,
    #[serde(default = "evenodd")]
    pub fill_rule: String,
}
impl Node {
    /// Figma VECTOR/OUTLINE masks cover the geometry of visible fill/stroke
    /// paints, independently of their color/positive alpha. This is a render
    /// projection only; authored paints, effects and edit history stay intact.
    pub(crate) fn outline_mask_node(&self, inherited: bool) -> Option<Node> {
        if !inherited && (!self.mask || self.mask_type.as_deref()!=Some("outline")) {return None;}
        let white=Paint {id:String::new(),kind:"solid".into(),color:"#ffffff".into(),opacity:1.,visible:true,
            angle:0.,stops:Vec::new(),image:None,fit:"cover".into(),blend:"normal".into(),transform:None,adjust:None,tile:None};
        let mut node=self.clone();
        node.fills=if self.fills.iter().any(|p|p.visible&&p.opacity>0.) {vec![white.clone()]} else {Vec::new()};
        for stroke in &mut node.strokes {
            stroke.visible=stroke.visible&&stroke.paint.visible&&stroke.paint.opacity>0.;
            stroke.paint=white.clone();
        }
        for run in &mut node.text_runs {run.color=None;}
        node.effects.clear();
        node.opacity=if self.opacity>0. {1.} else {0.};
        node.blend="normal".into();
        Some(node)
    }

    /// Preserve the old summation/multiplication order for existing documents.
    /// Native-sigma filters additionally reserve their complete 3-sigma support
    /// and bilinear neighbours in device pixels, even below unit zoom.
    pub fn effect_outset(&self, scale:f64) -> f64 {
        let old=self.effects.iter().filter(|e|e.visible && !matches!(e.kind.as_str(),"gaussian-blur"|"motion-blur"|"zoom-blur"))
            .map(|e|e.blur_radius()*2.+e.spread.abs()+e.x.abs()+e.y.abs()+e.material_halo()).sum::<f64>()*scale;
        old+self.effects.iter().filter(|e|e.visible && matches!(e.kind.as_str(),"gaussian-blur"|"motion-blur"))
            .map(|e|if e.radius>0. {3.*e.radius*scale+2.} else {0.}).sum::<f64>()
            +self.effects.iter().filter(|e|e.visible).filter_map(|e|e.zoom_blur).map(|z|if z.amount>0. {3.*z.amount*scale+2.} else {0.}).sum::<f64>()
    }
    pub fn fill_even_odd(&self) -> bool {
        self.vector_geometry
            .as_ref()
            .map(|g| g.fill_rule.as_str())
            .or_else(|| self.network.as_ref().map(|g| g.fill_rule.as_str()))
            != Some("nonzero")
    }
    pub fn requires_schema4(&self) -> bool {
        self.boolean_operation.is_some()
            || self.mask_type.is_some()
            || !self.bindings.is_empty()
            || !self.style_refs.is_empty()
            || self
                .text_runs
                .iter()
                .any(|r| r.color.is_some() || r.link.is_some() || r.underline || r.strikethrough)
            || self.text_style.as_ref().is_some_and(|s| {
                s.paragraph_spacing != 0. || s.paragraph_indent != 0. || s.align == "justify"
            })
            || self
                .fills
                .iter()
                .chain(self.strokes.iter().map(|s| &s.paint))
                .any(|p| p.transform.is_some() || matches!(p.kind.as_str(), "angular" | "diamond"))
    }
    pub fn render_children(&self) -> &[String] {
        if self.boolean_operation.is_some() {
            &[]
        } else {
            &self.children
        }
    }
    pub(crate) fn backdrop_effect(&self) -> Option<&Effect> {
        selected_backdrop(&self.effects)
    }
    pub(crate) fn passes_backdrop(&self) -> bool {
        // Figma keeps group opacity non-isolating, but a visible effect creates
        // an offscreen source. Verified against pass-through opacity/blur PNGs.
        self.blend == "pass-through" && !self.effects.iter().any(|e| e.visible)
    }
    pub(crate) fn composite_blend(&self) -> &str {
        if self.blend == "pass-through" {
            "normal"
        } else {
            &self.blend
        }
    }
    /// Path topology depends on these fields only. Paint, placement and effects
    /// are consumed later and must not invalidate the device-independent path.
    pub(crate) fn same_geometry(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.width == other.width
            && self.height == other.height
            && self.arc == other.arc
            && self.corner_radius == other.corner_radius
            && self.radii == other.radii
            && self.smoothing == other.smoothing
            && self.points == other.points
            && self.inner_radius == other.inner_radius
            && self.vector_brush == other.vector_brush
            && self.network == other.network
            && self.vector_geometry == other.vector_geometry
            && self.derived_path == other.derived_path
            && self.text == other.text
            && self.font_size == other.font_size
            && self.text_style == other.text_style
            && self.text_runs == other.text_runs
    }
}

/// Background filters occupy one mutually exclusive slot. Select the first
/// visible slot before testing its strength, so a disabled filter cannot
/// accidentally activate a later entry. Modern glass retains its measured
/// minimum capture filter; only fully neutral legacy glass skips capture.
pub fn selected_backdrop(effects: &[Effect]) -> Option<&Effect> {
    effects
        .iter()
        .find(|e| e.visible && matches!(e.kind.as_str(), "background-blur" | "glass"))
        .filter(|e| e.backdrop_radius() > 0. || e.color_controls.is_some_and(|c| !c.is_identity()) || (e.kind == "glass" && e.glass_active()))
}
impl Network {
    pub fn paths(&self) -> Result<(Path, Path), String> {
        self.paths_and_faces(&mut Vec::new())
    }
    pub fn faces(&self) -> Result<Vec<(Vec<String>, Path)>, String> {
        let mut faces = Vec::new();
        self.paths_and_faces(&mut faces)?;
        Ok(faces)
    }
    fn paths_and_faces(
        &self,
        faces: &mut Vec<(Vec<String>, Path)>,
    ) -> Result<(Path, Path), String> {
        if self.filled_faces.as_ref().is_some_and(|fs| {
            fs.len() > 10000
                || fs.iter().any(|f| {
                    f.len() > 10000 || f.iter().any(|id| !self.edges.iter().any(|e| e.id == *id))
                })
        }) {
            return Err("Invalid vector fill faces".into());
        }
        let vertices: HashMap<_, _> = self
            .vertices
            .iter()
            .map(|v| (v.id.as_str(), v.point()))
            .collect();
        if vertices.len() != self.vertices.len() {
            return Err("Duplicate vector vertex".into());
        }
        let mut incident: HashMap<&str, Vec<(usize, bool)>> = HashMap::new();
        for (i, e) in self.edges.iter().enumerate() {
            if !vertices.contains_key(e.from.as_str()) || !vertices.contains_key(e.to.as_str()) {
                return Err("Missing vector vertex".into());
            }
            incident.entry(&e.from).or_default().push((i, false));
            incident.entry(&e.to).or_default().push((i, true));
        }
        let direction = |index: usize, reverse: bool| {
            let e = &self.edges[index];
            let (a, b, c) = if reverse {
                (vertices[e.to.as_str()], vertices[e.from.as_str()], e.c2)
            } else {
                (vertices[e.from.as_str()], vertices[e.to.as_str()], e.c1)
            };
            let tangent = c.filter(|p| (*p - a).length() > 1e-10).unwrap_or(b) - a;
            tangent.y.atan2(tangent.x)
        };
        for es in incident.values_mut() {
            es.sort_by(|a, b| direction(a.0, a.1).total_cmp(&direction(b.0, b.1)));
        }
        let emit = |path: &mut Path, index: usize, reverse: bool, mov: bool| {
            let e = &self.edges[index];
            let (a, b, c1, c2) = if reverse {
                (
                    vertices[e.to.as_str()],
                    vertices[e.from.as_str()],
                    e.c2,
                    e.c1,
                )
            } else {
                (
                    vertices[e.from.as_str()],
                    vertices[e.to.as_str()],
                    e.c1,
                    e.c2,
                )
            };
            if mov {
                path.commands.push(Command::Move(a));
            }
            path.commands.push(if c1.is_some() || c2.is_some() {
                Command::Cubic(c1.unwrap_or(a), c2.unwrap_or(b), b)
            } else {
                Command::Line(b)
            });
        };
        let mut fill = Path::default();
        let mut visited = HashSet::new();
        for i in 0..self.edges.len() {
            for reverse in [false, true] {
                let first = (i, reverse);
                if visited.contains(&first) {
                    continue;
                }
                let mut current = first;
                let mut path = Path::default();
                let mut walked = Vec::new();
                let mut closed = false;
                for _ in 0..=self.edges.len() * 2 {
                    if !visited.insert(current) {
                        closed = current == first;
                        break;
                    }
                    emit(&mut path, current.0, current.1, walked.is_empty());
                    walked.push(current);
                    let e = &self.edges[current.0];
                    let end = if current.1 { &e.from } else { &e.to };
                    let es = &incident[end.as_str()];
                    let at = es
                        .iter()
                        .position(|v| *v == (current.0, !current.1))
                        .ok_or("Broken incidence")?;
                    current = es[(at + es.len() - 1) % es.len()];
                }
                if closed {
                    path.commands.push(Command::Close);
                    let cs = path.flatten(Transform::default(), 0.02)?;
                    let signed = cs.iter().map(|c| area(&c.points)).sum::<f64>();
                    let degree2 = walked.iter().all(|(i, _)| {
                        let e = &self.edges[*i];
                        incident[e.from.as_str()].len() == 2 && incident[e.to.as_str()].len() == 2
                    });
                    // Preserve authored orientation for simple rings. Face walks of
                    // branching networks select bounded faces instead.
                    if if degree2 {
                        walked.iter().min_by_key(|h| h.0).is_some_and(|h| !h.1)
                    } else {
                        signed > 1e-10
                    } {
                        let mut key: Vec<_> = walked
                            .iter()
                            .map(|(i, _)| self.edges[*i].id.clone())
                            .collect();
                        key.sort();
                        key.dedup();
                        faces.push((key.clone(), path.clone()));
                        if self.filled_faces.as_ref().is_none_or(|fs| {
                            fs.iter().any(|f| {
                                let mut f = f.clone();
                                f.sort();
                                f.dedup();
                                f == key
                            })
                        }) {
                            fill.commands.extend(path.commands);
                        }
                    }
                }
            }
        }
        let mut stroke = Path::default();
        let mut used = HashSet::new();
        let mut starts = Vec::new();
        // Preserve authored traversal. Hash-map iteration must never choose dash phase.
        for (i, e) in self.edges.iter().enumerate() {
            if incident[e.from.as_str()].len() != 2 {
                starts.push((e.from.as_str(), (i, false)));
            }
        }
        for (i, e) in self.edges.iter().enumerate() {
            if incident[e.to.as_str()].len() != 2 {
                starts.push((e.to.as_str(), (i, true)));
            }
        }
        for (i, e) in self.edges.iter().enumerate() {
            starts.push((&e.from, (i, false)));
        }
        for (start, mut h) in starts {
            if used.contains(&h.0) {
                continue;
            }
            let mut walk = Vec::new();
            let mut closed = false;
            while used.insert(h.0) {
                walk.push(h);
                let e = &self.edges[h.0];
                let end = if h.1 { e.from.as_str() } else { e.to.as_str() };
                if end == start {
                    closed = true;
                    break;
                }
                let es = &incident[end];
                if es.len() != 2 {
                    break;
                }
                if let Some(next) = es.iter().find(|h| !used.contains(&h.0)) {
                    h = *next;
                } else {
                    break;
                }
            }
            if walk.iter().min_by_key(|h| h.0).is_some_and(|h| h.1) {
                walk.reverse();
                for h in &mut walk {
                    h.1 = !h.1;
                }
            }
            for (i, h) in walk.iter().enumerate() {
                emit(&mut stroke, h.0, h.1, i == 0);
            }
            if closed {
                stroke.commands.push(Command::Close);
            }
        }
        Ok((fill, stroke))
    }
}
impl Node {
    pub fn paths(&self) -> Result<(Path, Path), String> {
        if let Some(brush) = &self.vector_brush {
            let guide = self
                .network
                .as_ref()
                .ok_or("Vector brush requires a guide network")?;
            let path = crate::vector_brush::paths(guide, brush)?;
            return Ok((path.clone(), path));
        }
        if self.path_offset != 0. {
            if !self.path_offset.is_finite() || self.path_offset.abs() > 10000. {
                return Err("Invalid path offset".into());
            }
            let mut source = self.clone();
            source.path_offset = 0.;
            let (fill, line) = source.paths()?;
            let contours = fill.flatten(Transform::default(), 0.005)?;
            let lines = line.flatten(Transform::default(), 0.005)?;
            let outline = crate::stroke::outline(
                &lines,
                self.path_offset.abs() * 2.,
                "round",
                "round",
                0.005,
            )?;
            let offset = if contours.is_empty() {
                if self.path_offset < 0. {
                    return Err("Open paths require a positive offset".into());
                }
                crate::boolean::boolean_with_rules(
                    &[outline],
                    crate::boolean::Operation::Union,
                    &[false],
                )?
            } else {
                crate::boolean::boolean_with_rules(
                    &[contours, outline],
                    if self.path_offset > 0. {
                        crate::boolean::Operation::Union
                    } else {
                        crate::boolean::Operation::Subtract
                    },
                    &[self.fill_even_odd(), false],
                )?
            };
            let mut path = Path::default();
            for contour in offset {
                path.commands
                    .extend(Path::polygon(&contour.points, true).commands)
            }
            return Ok((path.clone(), path));
        }
        if let Some(path) = &self.derived_path {
            return Ok((path.as_ref().clone(), path.as_ref().clone()));
        }
        // A rectangle, frame, section, or slice with a stored corner radius
        // draws that radius on the fill. An imported sharp outline must not
        // keep the corner square after the inspector saves TL/TR/BR/BL.
        if matches!(self.kind.as_str(), "slice" | "frame" | "section" | "rectangle")
            && (self.radii.iter().any(|radius| *radius != 0.) || self.smoothing != 0.)
        {
            let path = Path::rectangle(self.width, self.height, self.radii, self.smoothing);
            return Ok((path.clone(), path));
        }
        if let Some(g) = &self.network {
            return g.paths();
        }
        if let Some(geometry) = &self.vector_geometry {
            return geometry.paths();
        }
        let p = match self.kind.as_str() {
            "ellipse" => self.arc.map_or_else(
                || Path::ellipse(self.width, self.height),
                |arc| crate::authoring_shapes::ellipse_arc(self.width, self.height, arc),
            ),
            "line" => Path::polygon(
                &[Point::default(), Point::new(self.width, self.height)],
                false,
            ),
            "star" | "polygon" => {
                let count = self.points.clamp(3, 128) * if self.kind == "star" { 2 } else { 1 };
                let ps = (0..count)
                    .map(|i| {
                        let a = i as f64 * std::f64::consts::TAU / count as f64
                            - std::f64::consts::FRAC_PI_2;
                        let r = if self.kind == "star" && i % 2 != 0 {
                            self.inner_radius
                        } else {
                            1.
                        };
                        Point::new(
                            self.width / 2. + a.cos() * self.width / 2. * r,
                            self.height / 2. + a.sin() * self.height / 2. * r,
                        )
                    })
                    .collect::<Vec<_>>();
                crate::authoring_shapes::rounded_polygon(&ps, self.corner_radius)
            }
            // A vector without a network or derived path carries no drawable
            // geometry — Sketch zero-extent layers imported with a minimum
            // selection box land here and must render empty, not fail the
            // frame ("group"/"text" own no shape of their own either).
            "group" | "text" | "vector" => Path::default(),
            "slice" | "frame" | "section" | "rectangle" => {
                Path::rectangle(self.width, self.height, self.radii, self.smoothing)
            }
            _ => return Err(format!("Unsupported node kind {}", self.kind)),
        };
        Ok((
            if self.kind == "line" {
                Path::default()
            } else {
                p.clone()
            },
            p,
        ))
    }
}
impl Document {
    /// Visible zero-alpha/offscreen masks still constrain child content.
    pub fn mask_child(&self, node: &Node) -> Option<&Node> {
        if node.boolean_operation.is_some() {
            return None;
        }
        node.children
            .iter()
            .filter_map(|id| self.nodes.get(id))
            .find(|n| n.mask && n.visible)
    }
    pub(crate) fn validate_nodes<'a>(
        &self,
        nodes: impl IntoIterator<Item = (&'a String, &'a Node)>,
    ) -> Result<(), String> {
        for (id, n) in nodes {
            if self.schema_version < 16
                && n.boolean_operation
                    .is_some_and(|op| op.compound_rule().is_some())
            {
                return Err("Compound paths require schema 16".into());
            }
            if let Some(geometry) = &n.vector_geometry {
                if self.schema_version < 16
                    || n.kind != "vector"
                    || n.network.is_some()
                    || n.vector_brush.is_some()
                {
                    return Err("Vector render geometry requires schema 16 and one authoritative vector representation".into());
                }
                geometry.validate()?;
            }
            if self.schema_version < 15
                && (n.vector_brush.is_some()
                    || n.component.as_ref().is_some_and(|c| !c.slots.is_empty())
                    || n.instance
                        .as_ref()
                        .is_some_and(|i| !i.slot_contents.is_empty()))
            {
                return Err("Vector brushes and component slots require schema 15".into());
            }
            if self.schema_version < 15
                && (n
                    .text_style
                    .as_ref()
                    .is_some_and(|s| s.text_case != crate::font::TextCase::Original)
                    || n.text_runs.iter().any(|r| r.text_case.is_some()))
            {
                return Err("Display text case requires schema 15".into());
            }
            if let Some(repeat) = &n.repeat {
                if self.schema_version < 15 {
                    return Err("Repeated transforms require schema 15".into());
                }
                repeat.validate()?;
            }
            validate_guides(&n.guides, self.schema_version)?;
            if !n.guides.is_empty() && !matches!(n.kind.as_str(), "frame" | "section") {
                return Err("Only frames and sections own ruler guides".into());
            }
            if let Some(brush) = &n.vector_brush {
                if n.kind != "vector"
                    || n.network.is_none()
                    || n.path_offset != 0.
                    || n.boolean_operation.is_some()
                    || !n.children.is_empty()
                {
                    return Err("Vector brush requires a vector guide without offsets, booleans or children".into());
                }
                brush.validate()?;
                crate::vector_brush::paths(n.network.as_ref().unwrap(), brush)?;
            }
            if let Some(path) = &n.text_path {
                if self.schema_version < 10 || n.kind != "text" {
                    return Err("Text on path requires a schema 10 text node".into());
                }
                crate::text_path::Baseline::new(path)?;
            }
            if !n.path_offset.is_finite()
                || n.path_offset.abs() > 10000.
                || (n.path_offset != 0.
                    && (self.schema_version < 10
                        || matches!(
                            n.kind.as_str(),
                            "text" | "group" | "frame" | "section" | "slice"
                        )))
            {
                return Err("Invalid path offset".into());
            }
            if let Some(grid) = &n.layout_grid {
                if self.schema_version < 12 || n.kind != "frame" {
                    return Err("Layout grids require a schema 12 frame".into());
                }
                grid.validate(self.color_management.as_ref())?;
            }
            if let Some(board) = &n.board {
                if self.schema_version < 10
                    || !matches!(
                        board.kind.as_str(),
                        "sticky"
                            | "table"
                            | "code-block"
                            | "shape-whiteboard-square"
                            | "shape-whiteboard-ellipse"
                            | "shape-whiteboard-rounded-rectangle"
                            | "shape-whiteboard-triangle-up"
                            | "shape-whiteboard-triangle-down"
                            | "shape-whiteboard-diamond"
                            | "sites-responsive-set"
                    )
                {
                    return Err("Invalid whiteboard content".into());
                }
                if board.language.as_deref().is_some_and(|l| {
                    !matches!(
                        l,
                        "plain" | "javascript" | "typescript" | "rust" | "python" | "json"
                    )
                }) {
                    return Err("Invalid code language".into());
                }
                if board.kind == "table"
                    && (board.rows.is_none_or(|v| !(1..=50).contains(&v))
                        || board.columns.is_none_or(|v| !(1..=30).contains(&v))
                        || u64::from(board.rows.unwrap_or(0))
                            * u64::from(board.columns.unwrap_or(0))
                            > 600)
                {
                    return Err("Invalid table dimensions".into());
                }
            }
            if self.schema_version < 10
                && n.network.as_ref().is_some_and(|g| g.filled_faces.is_some())
            {
                return Err("Vector region fills require schema 10".into());
            }
            if n.kind == "slice"
                && (self.schema_version < 10
                    || !n.fills.is_empty()
                    || !n.strokes.is_empty()
                    || !n.effects.is_empty()
                    || !n.children.is_empty()
                    || n.network.is_some()
                    || n.mask)
            {
                return Err("Slice requires schema 10 and cannot contain painted content".into());
            }
            if self.schema_version < 10
                && n.export_settings
                    .iter()
                    .any(|s| !matches!(s.format.as_str(), "png" | "svg"))
            {
                return Err("Additional export formats require schemaVersion 10".into());
            }
            if self.schema_version < 8 && !n.export_settings.is_empty() {
                return Err("Layer exports require schema 8".into());
            }
            let mut export_ids = HashSet::new();
            if n.export_settings.len() > 16
                || n.export_settings.iter().any(|s| {
                    s.id.is_empty()
                        || s.id.len() > 128
                        || !export_ids.insert(&s.id)
                        || !matches!(
                            s.format.as_str(),
                            "png" | "svg" | "jpeg" | "jpg" | "webp" | "pdf" | "pdf-vector" | "tiff" | "eps"
                        )
                        || !s.scale.is_finite()
                        || !(0.0..=128.).contains(&s.scale)
                        || s.suffix.encode_utf16().count() > 80
                        || s.suffix
                            .chars()
                            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
                })
            {
                return Err("Invalid layer export settings".into());
            }
            if self.schema_version < 7
                && (n.arc.is_some() || n.corner_radius != 0. || n.constrain_proportions)
            {
                return Err("Native shape authoring requires schema 7".into());
            }
            crate::authoring_shapes::validate(
                &n.kind,
                n.arc,
                n.corner_radius,
                n.network.is_some(),
            )?;
            if self.schema_version < 6
                && (!n.variable_modes.is_empty()
                    || n.instance.as_ref().is_some_and(|i| {
                        i.overrides
                            .values()
                            .any(|f| f.contains_key("variableModes"))
                    }))
            {
                return Err("Node variable modes require schema 6".into());
            }
            if self.schema_version < 5
                && n.effects
                    .iter()
                    .any(|e| e.glass.is_some() || e.texture.is_some())
            {
                return Err("Material parameters require schema 5".into());
            }
            if self.schema_version < 4 && n.requires_schema4() {
                return Err("Extended authoring requires schema 4".into());
            }
            if n.mask_type
                .as_deref()
                .is_some_and(|v| !["alpha", "luminance", "outline"].contains(&v))
            {
                return Err("Invalid mask type".into());
            }
            if n.boolean_operation.is_some()
                && (n.kind != "vector" || n.children.is_empty() || n.children.len() > 64)
            {
                return Err("Boolean groups require 1–64 operands".into());
            }
            for paint in n.fills.iter().chain(n.strokes.iter().map(|s| &s.paint)) {
                if !paint.opacity.is_finite()
                    || !(0. ..=1.).contains(&paint.opacity)
                    || !paint.angle.is_finite()
                    || paint.angle.abs() > 1e7
                    || !matches!(
                        paint.kind.as_str(),
                        "solid" | "linear" | "radial" | "angular" | "diamond" | "image"
                    )
                    || paint.transform.is_some_and(|t| {
                        t.0.iter().any(|v| !v.is_finite() || v.abs() > 1e7) || t.inverse().is_err()
                    })
                    || !matches!(paint.fit.as_str(), "cover" | "contain" | "stretch")
                    || paint.stops.len() > MAX_GRADIENT_STOPS
                {
                    return Err(format!(
                        "Invalid paint parameters (kind={}, opacity={}, stops={}, transformInvertible={})",
                        paint.kind,
                        paint.opacity,
                        paint.stops.len(),
                        paint.transform.is_none_or(|t| t.inverse().is_ok())
                    ));
                }
                if paint.adjust.is_some()
                    && (paint.kind != "image"
                        || self.schema_version < 13
                        || paint.adjust.is_some_and(|a| !a.validate()))
                {
                    return Err("Image adjustments require an image paint and schema 13".into());
                }
                if paint.tile.is_some()
                    && (paint.kind != "image"
                        || self.schema_version < 14
                        || paint.tile.as_ref().is_some_and(|t| !t.validate()))
                {
                    return Err("Pattern tiling requires an image paint and schema 14".into());
                }
                crate::color::pixel(self.color_management, &paint.color, 1.)?;
                for stop in &paint.stops {
                    if !stop.offset.is_finite() || !(0. ..=1.).contains(&stop.offset) {
                        return Err("Invalid gradient stop".into());
                    }
                    crate::color::pixel(self.color_management, &stop.color, 1.)?;
                }
            }
            crate::font::validate_node(n)?;
            for font in n
                .text_style
                .iter()
                .flat_map(|style| std::iter::once(&style.font_id).chain(style.fallbacks.iter()))
                .chain(n.text_runs.iter().filter_map(|r| r.font_id.as_ref()))
            {
                if font != "default" && !self.fonts.contains_key(font) {
                    return Err(format!("Missing font resource: {font}"));
                }
            }
            n.validate_layout()?;
            n.validate_strokes()?;
            if (n.blend != "pass-through" && !crate::blend::valid_mode(&n.blend))
                || n.fills
                    .iter()
                    .chain(n.strokes.iter().map(|s| &s.paint))
                    .any(|p| !crate::blend::valid_mode(&p.blend))
            {
                return Err("Invalid blend mode: pass-through is only valid on layers".into());
            }
            if *id != n.id
                || n.transform
                    .0
                    .iter()
                    .any(|v| !v.is_finite() || v.abs() > 1e7)
                || n.transform.inverse().is_err()
                || [n.width, n.height, n.font_size]
                    .iter()
                    .any(|v| !v.is_finite() || *v <= 0. || *v > 1e7)
                || !n.opacity.is_finite()
                || n.opacity < 0.
                || n.opacity > 1.
                || n.fills.len() > 16
                || n.strokes.len() > 16
                || n.effects.len() > 16
            {
                return Err("Invalid scene node".into());
            }
            if let Some(g) = &n.network
                && (g.vertices.len() > 10000
                    || g.edges.len() > 20000
                    || g.vertices
                        .iter()
                        .any(|v| !v.point().finite() || v.x.abs() > 1e7 || v.y.abs() > 1e7)
                    || g.edges
                        .iter()
                        .any(|e| [e.c1, e.c2].into_iter().flatten().any(|p| !p.finite())))
            {
                return Err(format!(
                    "Invalid vector network ({} vertices, {} edges; finite coordinates within the admitted range are required)",
                    g.vertices.len(),
                    g.edges.len()
                ));
            }
            for e in &n.effects {
                if matches!(e.kind.as_str(),"gaussian-blur"|"motion-blur") && self.schema_version<18 {return Err("Spatial sigma filters require schema 18".into());}
                if (e.color_controls.is_some() || e.kind == "color-controls") && self.schema_version < 17 {
                    return Err("Color controls require schema 17".into());
                }
                e.validate_material()?;
                crate::color::pixel(self.color_management, &e.color, 1.)?;
                if [e.radius, e.spread, e.x, e.y, e.amount, e.opacity]
                    .iter()
                    .any(|v| !v.is_finite())
                    || e.radius < 0.
                    || e.radius > 1000.
                    || !(0. ..=1.).contains(&e.opacity)
                {
                    return Err("Invalid effect parameters".into());
                }
            }
        }
        Ok(())
    }
    pub fn requires_schema20(&self) -> bool {
        fn extended(a:&crate::prototype::Action)->bool {a.transition_style.is_some() || a.then_actions.iter().flatten().chain(a.else_actions.iter().flatten()).any(extended)}
        if self.prototype.as_ref().is_some_and(|p|p.interactions.values().flatten().flat_map(|e|&e.actions).any(extended)) {return true}
        let style = |v: &serde_json::Value| v.get("verticalAlign").and_then(|v|v.as_str()).is_some_and(|v|v!="top");
        let runs = |v: &serde_json::Value| v.as_array().is_some_and(|r|r.iter().any(|v|v.get("paragraph").is_some_and(|p|!p.is_null())));
        self.nodes.values().any(|n| n.text_style.as_ref().is_some_and(|s|s.vertical_align!="top") || n.text_runs.iter().any(|r|r.paragraph.is_some())
            || n.instance.as_ref().is_some_and(|i|i.overrides.values().any(|o|o.get("textStyle").is_some_and(style)||o.get("textRuns").is_some_and(runs))))
            || self.design_system.as_ref().is_some_and(|d|d.styles.values().any(|s|s.kind=="text" && style(&s.value)))
    }
    pub fn requires_schema19(&self) -> bool {
        let spatial=|e:&Effect|matches!(e.kind.as_str(),"zoom-blur");
        let raw=|v:&serde_json::Value|v.as_array().is_some_and(|es|es.iter().any(|e|matches!(e.get("kind").and_then(|k|k.as_str()),Some("zoom-blur"))));
        self.nodes.values().any(|n|n.effects.iter().any(spatial) || n.instance.as_ref().is_some_and(|i|i.overrides.values().any(|o|o.get("effects").is_some_and(raw))))
            || self.animations.iter().flat_map(|c|&c.tracks).flat_map(|t|&t.keyframes).any(|k|k.value.effects.iter().any(spatial))
            || self.design_system.as_ref().is_some_and(|d|d.styles.values().any(|s|s.effects.iter().any(spatial)||(s.kind=="effect"&&raw(&s.value))))
    }
    pub fn requires_schema18(&self) -> bool {
        let spatial=|e:&Effect|matches!(e.kind.as_str(),"gaussian-blur"|"motion-blur");
        let raw=|v:&serde_json::Value|v.as_array().is_some_and(|es|es.iter().any(|e|matches!(e.get("kind").and_then(|k|k.as_str()),Some("gaussian-blur"|"motion-blur"))));
        self.nodes.values().any(|n|n.effects.iter().any(spatial) || n.instance.as_ref().is_some_and(|i|i.overrides.values().any(|o|o.get("effects").is_some_and(raw))))
            || self.animations.iter().flat_map(|c|&c.tracks).flat_map(|t|&t.keyframes).any(|k|k.value.effects.iter().any(spatial))
            || self.design_system.as_ref().is_some_and(|d|d.styles.values().any(|s|s.effects.iter().any(spatial)||(s.kind=="effect"&&raw(&s.value))))
    }
    pub fn requires_schema17(&self) -> bool {
        let raw = |value: &serde_json::Value| value.as_array().is_some_and(|es|es.iter().any(|e|
            e.get("kind").and_then(|k|k.as_str())==Some("color-controls") || e.get("colorControls").is_some_and(|c|!c.is_null())));
        self.nodes.values().any(|n|n.effects.iter().any(|e|e.color_controls.is_some() || e.kind=="color-controls")
            || n.instance.as_ref().is_some_and(|i|i.overrides.values().any(|o|o.get("effects").is_some_and(raw))))
            || self.animations.iter().flat_map(|c|&c.tracks).flat_map(|t|&t.keyframes)
                .any(|k|k.value.effects.iter().any(|e|e.color_controls.is_some() || e.kind=="color-controls"))
            || self.design_system.as_ref().is_some_and(|d|d.styles.values().any(|s|
                s.effects.iter().any(|e|e.color_controls.is_some() || e.kind=="color-controls") || (s.kind=="effect" && raw(&s.value))))
    }
    /// Native source storage validates the same scene semantics without the
    /// serialized JS/WASM carrier or logical node/page quotas.
    #[cfg(not(target_arch="wasm32"))]
    pub fn validate_native_source(&self) -> Result<(), String> {
        crate::capacity::with_source_storage_scope(true,||self.validate())
    }
    pub fn validate(&self) -> Result<(), String> {
        self.validate_edit_scope(None)
    }
    /// Only the resident derivation owner may reuse previously validated node
    /// bodies. Its field-free patch names every source mutation; after scoped
    /// resolution it must name every old/new node in the affected islands.
    /// All whole-document schema, graph, component and reference checks remain.
    pub(crate) fn validate_scoped_edit(&self, nodes:&std::collections::BTreeSet<String>) -> Result<(),String> {
        self.validate_edit_scope(Some(nodes))
    }
    fn validate_edit_scope(&self, changed:Option<&std::collections::BTreeSet<String>>) -> Result<(),String> {
        if self.schema_version<20 && self.requires_schema20() {return Err("Paragraph and vertical text layout require schema 20".into());}
        if self.schema_version<19 && self.requires_schema19() {return Err("Zoom blur requires schema 19".into());}
        if self.schema_version<18 && self.requires_schema18() {return Err("Spatial sigma filters require schema 18".into());}
        if self.schema_version < 17 && self.requires_schema17() { return Err("Color controls require schema 17".into()); }
        if let Some(compatibility) = &self.fd_compatibility {
            compatibility.validate()?;
        }
        crate::reviews::validate(self)?;
        crate::connectors::validate(self)?;
        let has_gradient = self
            .nodes
            .values()
            .any(|n| n.effects.iter().any(|e| e.gradient_blur.is_some()))
            || self
                .animations
                .iter()
                .flat_map(|c| &c.tracks)
                .flat_map(|t| &t.keyframes)
                .any(|k| k.value.effects.iter().any(|e| e.gradient_blur.is_some()));
        let has_gradient = has_gradient
            || self.nodes.values().any(|n| {
                n.instance.as_ref().is_some_and(|i| {
                    i.overrides.values().any(|o| {
                        o.get("effects")
                            .and_then(|v| v.as_array())
                            .is_some_and(|es| {
                                es.iter()
                                    .any(|e| e.get("gradientBlur").is_some_and(|g| !g.is_null()))
                            })
                    })
                })
            })
            || self.design_system.as_ref().is_some_and(|d| {
                d.styles.values().any(|s| {
                    s.kind == "effect"
                        && s.value.as_array().is_some_and(|es| {
                            es.iter()
                                .any(|e| e.get("gradientBlur").is_some_and(|g| !g.is_null()))
                        })
                })
            });
        if self.schema_version < 9 && has_gradient {
            return Err("Gradient blur requires schema 9".into());
        }

        if self.schema_version < 8
            && self.nodes.values().any(|n| {
                !n.export_settings.is_empty()
                    || n.instance.as_ref().is_some_and(|i| {
                        i.overrides.values().any(|o| {
                            o.get("exportSettings")
                                .and_then(|v| v.as_array())
                                .is_some_and(|v| !v.is_empty())
                        })
                    })
            })
        {
            return Err("Layer exports require schema 8".into());
        }
        if self.schema_version < 8 && crate::stroke::has_markers(self) {
            return Err("Stroke markers require schema 8".into());
        }
        if self.schema_version < 5
            && self.design_system.as_ref().is_some_and(|d| {
                d.styles.values().any(|s| {
                    s.kind == "effect"
                        && s.value.as_array().is_some_and(|effects| {
                            effects.iter().any(|e| {
                                e.get("glass").is_some_and(|v| !v.is_null())
                                    || e.get("texture").is_some_and(|v| !v.is_null())
                            })
                        })
                })
            })
        {
            return Err("Material styles require schema 5".into());
        }
        if self.schema_version < 4 && (self.design_system.is_some() || self.prototype.is_some()) {
            return Err("Design systems and prototypes require schema 4".into());
        }
        for page in &self.pages {
            validate_guides(&page.guides, self.schema_version)?;
        }
        if self.pages.iter().map(|p| p.guides.len()).sum::<usize>()
            + self.nodes.values().map(|n| n.guides.len()).sum::<usize>()
            > 20000
        {
            return Err("Ruler guide limit exceeded".into());
        }
        if ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].contains(&self.schema_version)
            || self.name.trim().is_empty()
            || self.name.encode_utf16().count() > 200
            || self.fonts.len() > 32
        {
            return Err("Document limits exceeded".into());
        }
        crate::capacity::check_document_counts(self.nodes.len(), self.pages.len())?;
        if let Some(settings) = self.color_management {
            if self.schema_version < 3 {
                return Err("Color management requires schema 3".into());
            }
            settings.validate()?;
            if self.raster_profile == Some(crate::fidelity::RasterProfile::Analytic) {
                return Err("Managed documents require fine coverage".into());
            }
        }
        for page in &self.pages {
            crate::color::pixel(self.color_management, &page.background, 1.)?;
        }
        self.validate_nodes(self.nodes.iter().filter(|(id,_)|changed.is_none_or(|ids|ids.contains(*id))))?;
        fn visit<'a>(
            d: &'a Document,
            id: &'a str,
            depth: usize,
            seen: &mut HashSet<&'a str>,
        ) -> Result<(), String> {
            if depth > 64 || !seen.insert(id) {
                return Err("Cyclic or repeated node".into());
            }
            let n = d.nodes.get(id).ok_or("Missing node")?;
            for c in &n.children {
                visit(d, c, depth + 1, seen)?;
            }
            Ok(())
        }
        let mut seen = HashSet::new();
        for p in &self.pages {
            for id in &p.children {
                visit(self, id, 0, &mut seen)?;
            }
        }
        if seen.len() != self.nodes.len() {
            return Err("Unreachable node".into());
        }
        crate::repeat::validate_document(self)?;
        crate::components::validate(self)?;
        crate::animation::validate(self)?;
        crate::design_system::validate(self)?;
        crate::prototype::validate(self)?;
        Ok(())
    }
}

#[cfg(test)]
mod layout_grid_tests {
    use super::*;

    #[test]
    fn tracks_derive_from_extent_with_margin_and_gutter() {
        let grid = LayoutGrid {
            axis: "column".into(),
            count: 3,
            gutter: 10.,
            margin: 20.,
            color: "#ff0000".into(),
            visible: true,
            opacity: 1.,
        };
        // (100 - 2*20 - 2*10) / 3 = 40/3
        let tracks = grid.tracks(100.);
        assert_eq!(tracks, vec![40. / 3., 10., 40. / 3., 10., 40. / 3.]);
        // uniform grids repeat the derived square cell on both axes
        let uniform = LayoutGrid {
            axis: "uniform".into(),
            count: 4,
            gutter: 0.,
            margin: 0.,
            ..grid
        };
        assert_eq!(uniform.tracks(200.), vec![50., 0., 50., 0., 50., 0., 50.]);
    }

    #[test]
    fn validate_rejects_open_ranges_and_bad_colors() {
        let base = LayoutGrid {
            axis: "column".into(),
            count: 12,
            gutter: 20.,
            margin: 0.,
            color: "#00ff00".into(),
            visible: true,
            opacity: 0.5,
        };
        assert!(base.validate(None).is_ok());
        for bad in [
            LayoutGrid {
                axis: "diagonal".into(),
                ..base.clone()
            },
            LayoutGrid {
                count: 0,
                ..base.clone()
            },
            LayoutGrid {
                count: 65,
                ..base.clone()
            },
            LayoutGrid {
                gutter: -1.,
                ..base.clone()
            },
            LayoutGrid {
                gutter: f64::NAN,
                ..base.clone()
            },
            LayoutGrid {
                margin: f64::INFINITY,
                ..base.clone()
            },
            LayoutGrid {
                opacity: 1.5,
                ..base.clone()
            },
            LayoutGrid {
                color: "nope".into(),
                ..base.clone()
            },
        ] {
            assert!(bad.validate(None).is_err(), "{:?}", bad.axis);
        }
    }
}

#[cfg(test)]
mod storage_layout_tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn shared_network_detaches_only_for_a_real_geometry_write() {
        let mut source=crate::facet::sample_node("n","vector");source.width=10.;source.height=10.;
        source.network=Some(serde_json::from_value(serde_json::json!({"vertices":[{"id":"a","x":-0.0,"y":1.25},{"id":"b","x":10,"y":10}],"edges":[{"id":"e","from":"a","to":"b","c1":{"x":1,"y":2}}],"fillRule":"nonzero"})).unwrap());
        let encoded=serde_json::to_vec(&source).unwrap();let mut copy=source.clone();
        assert!(Arc::ptr_eq(source.network.as_ref().unwrap(),copy.network.as_ref().unwrap()));
        crate::mutation::resize(&mut copy,10.,10.);
        assert!(Arc::ptr_eq(source.network.as_ref().unwrap(),copy.network.as_ref().unwrap()));
        crate::mutation::resize(&mut copy,20.,30.);
        assert!(!Arc::ptr_eq(source.network.as_ref().unwrap(),copy.network.as_ref().unwrap()));
        assert_eq!(serde_json::to_vec(&source).unwrap(),encoded);
        assert_eq!(copy.network.as_ref().unwrap().vertices[1].x,20.);
        assert_eq!(copy.network.as_ref().unwrap().vertices[1].y,30.);
        assert_eq!(copy.network.as_ref().unwrap().vertices[0].x.to_bits(),(-0_f64).to_bits());
    }
    #[test]
    fn frozen_vector_capacity_keeps_wire_values_and_cold_payloads_are_indirect() {
        let mut n=crate::facet::sample_node("n","rectangle");n.fills.reserve(30);n.effects.reserve(10);n.strokes.reserve(10);
        let encoded=serde_json::to_vec(&n).unwrap();n.compact_storage();
        assert_eq!(serde_json::to_vec(&n).unwrap(),encoded);
        assert_eq!(n.fills.capacity(),n.fills.len());assert_eq!(n.effects.capacity(),0);assert_eq!(n.strokes.capacity(),0);
        assert!(std::mem::size_of::<Node>()<=1024,"hot Node slots must not regain inline cold payloads: {}",std::mem::size_of::<Node>());
    }
    #[test]
    fn stored_top_left_radius_rounds_the_fill_ahead_of_a_sharp_outline() {
        use crate::math::Point;
        use crate::path::Command;
        let mut node = crate::facet::sample_node("n", "rectangle");
        node.width = 100.;
        node.height = 80.;
        node.radii = [24., 0., 0., 0.];
        let sharp = crate::path::Path::polygon(
            &[
                Point::new(0., 0.),
                Point::new(100., 0.),
                Point::new(100., 80.),
                Point::new(0., 80.),
            ],
            true,
        );
        node.vector_geometry = Some(Arc::new(
            crate::vector_geometry::VectorGeometry::from_paths(&sharp, &sharp, "nonzero").unwrap(),
        ));
        let (fill, stroke) = node.paths().unwrap();
        assert!(fill.commands.iter().any(|command| matches!(command, Command::Arc { .. })));
        assert!(stroke.commands.iter().any(|command| matches!(command, Command::Arc { .. })));
        let flat = fill.flatten(crate::math::Transform::default(), 0.5).unwrap();
        let points = &flat[0].points;
        assert!(points.iter().any(|point| point.x < 8. && point.y < 8.));
        assert!(points.iter().all(|point| point.x > 1. || point.y > 1.));
    }
}
