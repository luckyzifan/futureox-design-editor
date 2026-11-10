//! Shared glyph shaping, Unicode wrapping and portable font resources.
//! UAX #9 visual runs, UAX #14 break opportunities and UAX #29 graphemes
//! delimit shaping; line breaks never split a shaped cluster.
use crate::{
    math::Point,
    path::{Command, Path},
    scene::Node,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr as _;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, RwLock},
};
use unicode_segmentation::UnicodeSegmentation;

/// Inspect only the selected file. Browser/local file imports use these face
/// indices instead of assuming a collection's first face matches its name.
pub fn faces_json(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Font file exceeds 20 MiB".into());
    }
    let count = ttf_parser::fonts_in_collection(bytes).unwrap_or(1);
    if count > 256 {
        return Err("Font collection exceeds 256 faces".into());
    }
    let mut faces = Vec::new();
    for index in 0..count {
        let face = ttf_parser::Face::parse(bytes, index).map_err(|_| "Invalid font face")?;
        let name = |id| {
            face.names()
                .into_iter()
                .filter(|n| n.name_id == id)
                .find_map(|n| n.to_string())
                .unwrap_or_default()
        };
        // Legacy name IDs stay in family/style so existing importers keep their
        // current identity. Typographic names, OS/2 weight and fvar axes are
        // additive: a variable file can be matched by wght instead of a static
        // style sibling. At most 16 axes are reported.
        let mut axes = Vec::new();
        for axis in face.variation_axes() {
            if axes.len() >= 16 {
                break;
            }
            let tag = axis.tag.to_string();
            if tag.len() != 4
                || !tag.chars().all(|c| c.is_ascii_alphanumeric())
                || ![axis.min_value, axis.def_value, axis.max_value]
                    .iter()
                    .all(|value| value.is_finite())
            {
                continue;
            }
            axes.push(serde_json::json!({
                "tag": tag,
                "min": axis.min_value,
                "default": axis.def_value,
                "max": axis.max_value,
            }));
        }
        faces.push(serde_json::json!({
            "index": index,
            "family": name(ttf_parser::name_id::FAMILY),
            "style": name(ttf_parser::name_id::SUBFAMILY),
            "postscript": name(ttf_parser::name_id::POST_SCRIPT_NAME),
            "typographicFamily": name(ttf_parser::name_id::TYPOGRAPHIC_FAMILY),
            "typographicStyle": name(ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY),
            "weight": face.weight().to_number(),
            "italic": face.is_italic() || face.is_oblique(),
            "variable": face.is_variable(),
            "axes": axes,
        }));
    }
    serde_json::to_string(&faces).map_err(|e| e.to_string())
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextStyle {
    #[serde(skip_serializing_if = "is_top")]
    pub vertical_align: String,
    #[serde(skip_serializing_if = "TextCase::is_original")]
    pub text_case: TextCase,
    pub paragraph_spacing: f64,
    pub paragraph_indent: f64,
    pub font_id: String,
    pub fallbacks: Vec<String>,
    pub weight: f32,
    pub line_height: f64,
    pub letter_spacing: f64,
    pub wrap: bool,
    pub align: String,
    pub direction: String,
    /// OpenType feature toggles in harfbuzz syntax ("liga", "-liga", "kern",
    /// "ss01"), applied while shaping. The default empty list keeps the
    /// font's own defaults, matching historical output bit-for-bit.
    pub features: Vec<String>,
    /// Variation-axis values beyond the reserved `wght` (which follows
    /// `weight`). Example: [{"tag":"wdth","value":75}].
    pub variations: Vec<TextVariation>,
    /// "horizontal" (default) or "vertical". Vertical stacks CJK upright and
    /// rotates non-CJK runs a quarter turn clockwise, the conventional CJK
    /// mixed layout; wrapping stays horizontal-only.
    pub writing_mode: String,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TextCase {
    #[default]
    Original,
    Upper,
    Lower,
    /// kiwi `TextCase` ordinal 3 — uppercase the first cased letter of each
    /// word, lowercase the rest (display layer in `text_case.rs`).
    Title,
    /// kiwi ordinal 4 — OpenType `smcp` small caps. The display layer keeps
    /// the authored string until the font shaper applies the feature; the
    /// value round-trips through import/export unchanged.
    SmallCaps,
    /// kiwi ordinal 5 — OpenType `smcp`+`c2sc` forced small caps (uppercase
    /// letters are also replaced).
    SmallCapsForced,
}
impl TextCase {
    fn is_original(&self) -> bool {
        *self == Self::Original
    }
}
/// One named variation-axis coordinate on a variable font.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextVariation {
    pub tag: String,
    pub value: f64,
}
fn is_top(s: &str) -> bool {
    s == "top"
}
impl Default for TextStyle {
    fn default() -> Self {
        Self {
            vertical_align: "top".into(),
            text_case: TextCase::Original,
            paragraph_spacing: 0.,
            paragraph_indent: 0.,
            font_id: "default".into(),
            fallbacks: vec![],
            weight: 400.,
            line_height: 1.35,
            letter_spacing: 0.,
            wrap: false,
            align: "start".into(),
            direction: "auto".into(),
            features: vec![],
            variations: vec![],
            writing_mode: "horizontal".into(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TextParagraph {
    pub align: String,
    /// Absolute document units; zero means unconstrained font-based height.
    pub minimum_line_height: f64,
    pub maximum_line_height: f64,
    pub spacing: f64,
    pub indent: f64,
}
impl Default for TextParagraph {
    fn default() -> Self {
        Self {
            align: "start".into(),
            minimum_line_height: 0.,
            maximum_line_height: 0.,
            spacing: 0.,
            indent: 0.,
        }
    }
}
impl TextParagraph {
    pub fn validate(&self) -> Result<(), String> {
        if !["start", "center", "end", "justify"].contains(&self.align.as_str())
            || [
                self.minimum_line_height,
                self.maximum_line_height,
                self.spacing,
            ]
            .iter()
            .any(|v| !v.is_finite() || !(0. ..=10000.).contains(v))
            || !self.indent.is_finite()
            || self.indent.abs() > 10000.
            || (self.maximum_line_height > 0.
                && self.minimum_line_height > self.maximum_line_height)
        {
            return Err("Invalid paragraph style".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    /// Paragraph attributes at the first character of each paragraph. UTF-16
    /// ranges stay with their text through editing, case mapping and overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraph: Option<TextParagraph>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_case: Option<TextCase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "crate::components::is_false")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "crate::components::is_false")]
    pub strikethrough: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// UTF-16 offsets, matching browser selectionStart/selectionEnd.
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,
    /// Extra advance after this run's clusters, in design pixels. `None`
    /// keeps the node style's letter spacing. Figma PERCENT is resolved to
    /// pixels at import using the run's font size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<f64>,
    /// Line-box multiplier for this run's font size. `None` keeps the node
    /// style's multiplier. A line that contains any override uses the maximum
    /// resolved pixel height instead of the node font-size floor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct FontResource {
    pub family: String,
    pub data: Arc<str>,
    /// Face index inside a collection (TTC/OTC). `0` for plain files; the
    /// scanner supplies the selected style's index so collections do not
    /// silently rasterise their first face.
    #[serde(default)]
    pub index: u32,
    /// PostScript name of the selected face, when the scanner knows it. Used
    /// verbatim when exporting so consumers receive a resolvable font name
    /// instead of the resource id digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postscript: Option<String>,
}
#[derive(Clone)]
struct FontData {
    bytes: Arc<Vec<u8>>,
    digest: [u8; 32],
    index: u32,
}
// Each resident face owns its immutable bytes through a safe self-borrowing
// container. Arc clones share the parsed GSUB/GPOS tables instead of rebuilding
// their coverage digests for every glyph ascent, shaping run, or outline miss.
// No leaked buffers, lifetime casts, or hand-written unsafe ownership are used.
#[ouroboros::self_referencing]
struct ParsedFontFace {
    key: FontFaceKey,
    bytes: Arc<Vec<u8>>,
    #[borrows(bytes)]
    #[covariant]
    face: rustybuzz::Face<'this>,
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct FontFaceKey {
    font: [u8; 32],
    index: u32,
    weight: u32,
    // Preserve order and exact f32 values, including duplicate axes: the
    // existing set_variations sequence, not a normalized approximation.
    axes: Vec<([u8; 4], u32)>,
}
struct FontFaceCache {
    inner: crate::read_cache::ReadCache<FontFaceKey, ParsedFontFace>,
    builds: u64,
}
impl Default for FontFaceCache {
    fn default() -> Self {
        Self {
            inner: crate::read_cache::ReadCache::new(128 * 1024 * 1024, 64),
            builds: 0,
        }
    }
}
impl ParsedFontFace {
    fn residency_charge(&self) -> usize {
        // Conservatively charge the *whole* byte owner per variation, even
        // when several entries share it. rustybuzz 0.20.1 owns only lookup and
        // subtable vectors beyond its inline face; ttf-parser tables are views.
        // Include Vec growth slack and count repeated lookup offsets separately.
        let face = self.borrow_face();
        let mut bytes = self
            .borrow_bytes()
            .capacity()
            .saturating_add(std::mem::size_of::<rustybuzz::Face<'_>>() + 512)
            .saturating_add(self.borrow_key().axes.capacity() * 36);
        for table in [face.tables().gsub, face.tables().gpos]
            .into_iter()
            .flatten()
        {
            bytes = bytes.saturating_add(usize::from(table.lookups.len()).max(4) * 256);
            for lookup in table.lookups {
                let subtable_size =
                    std::mem::size_of::<ttf_parser::gsub::SubstitutionSubtable<'_>>()
                        .max(std::mem::size_of::<ttf_parser::gpos::PositioningSubtable<'_>>());
                bytes = bytes.saturating_add(
                    usize::from(lookup.subtables.len())
                        .max(4)
                        .saturating_mul(subtable_size)
                        .saturating_mul(2),
                );
            }
        }
        bytes
    }
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct ShapedRunKey {
    face: FontFaceKey,
    text: String,
    features: Vec<([u8; 4], u32, u32, u32)>,
    direction: u8,
    script: rustybuzz::Script,
    language: Option<rustybuzz::Language>,
    flags: u32,
    cluster_level: u8,
}
struct ShapedRun {
    infos: Vec<rustybuzz::GlyphInfo>,
    positions: Vec<rustybuzz::GlyphPosition>,
}
struct ShapedRunCache {
    inner: crate::read_cache::ReadCache<ShapedRunKey, ShapedRun>,
    builds: u64,
}
impl Default for ShapedRunCache {
    fn default() -> Self {
        Self {
            inner: crate::read_cache::ReadCache::new(8 * 1024 * 1024, 1024),
            builds: 0,
        }
    }
}
#[derive(Clone, Default)]
pub struct Fonts {
    data: Arc<Vec<u8>>,
    data_digest: [u8; 32],
    outlines: Arc<RwLock<crate::font_glyph_cache::Cache>>,
    text_paths: Arc<RwLock<crate::text_path_cache::Cache>>,
    faces: Arc<RwLock<FontFaceCache>>,
    shaped_runs: Arc<RwLock<ShapedRunCache>>,
    named: BTreeMap<String, FontData>,
    /// Sketch's `allowFontSubpixelQuantization` counterpart: quantise each
    /// glyph's painted outline origin to whole local units. Off by default —
    /// shaped advances, layout, wrapping and caret geometry keep their
    /// fractional grid either way; only the drawn outlines move (the
    /// CoreText rendering-side quantisation, which never moves string
    /// positions). At zoom 1 with an integer camera this is device-pixel
    /// quantisation, the crisp-text case Sketch presents at 100%.
    quantize_glyph_origins: bool,
}
/// Small immutable identity of the font inputs, independent of mutable caches.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct FontSourceStamp {
    default: [u8; 32],
    named: BTreeMap<String, ([u8; 32], u32)>,
    quantized: bool,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum OutlineOutput {
    None,
    Geometry,
    Spans,
    Svg,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Glyph {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_transform: Option<crate::math::Transform>,
    pub id: u16,
    pub font_id: String,
    pub size: f64,
    pub weight: f32,
    pub cluster: usize,
    pub cluster_end: usize,
    pub x: f64,
    pub y: f64,
    pub advance: f64,
    #[serde(skip)]
    byte: usize,
    /// Variation coordinates this glyph was shaped with; outlines rebuild the
    /// same face so geometry matches the shaped advances exactly.
    #[serde(skip)]
    vars: Vec<rustybuzz::Variation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub start: usize,
    pub end: usize,
    pub width: f64,
    pub y: f64,
    pub height: f64,
}
#[derive(Serialize)]
pub struct TextLayout {
    pub spans: Vec<TextSpan>,
    pub width: f64,
    pub height: f64,
    pub lines: Vec<TextLine>,
    pub glyphs: Vec<Glyph>,
    pub bounds: Option<crate::bounds::Bounds>,
    #[serde(skip)]
    pub path: Path,
}
#[derive(Serialize)]
pub struct TextSpan {
    pub path: String,
    pub color: Option<String>,
    pub link: Option<String>,
    #[serde(skip)]
    pub outline: Path,
}
/// Insertion caret geometry for one UTF-16 boundary, in the node-local
/// design space of `TextLayout::glyphs` (compose with `Node::transform`
/// for page coordinates). Horizontal carets span their line box at the
/// boundary's x. Vertical carets occupy an em-sized slot centered on the
/// flow boundary inside the column. `tilt` marks boundaries inside rotated
/// Latin runs of vertical writing, which conventionally render slanted.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caret {
    pub x: f64,
    pub y: f64,
    pub height: f64,
    pub tilt: bool,
}
fn valid_font_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128
}
impl TextStyle {
    pub fn validate(&self) -> Result<(), String> {
        if !["top", "center", "bottom"].contains(&self.vertical_align.as_str())
            || !valid_font_id(&self.font_id)
            || self.fallbacks.len() > 16
            || self.fallbacks.iter().any(|id| !valid_font_id(id))
            || !self.weight.is_finite()
            || !(1. ..=1000.).contains(&self.weight)
            || !self.line_height.is_finite()
            || !(0.1..=10.).contains(&self.line_height)
            || !self.letter_spacing.is_finite()
            || self.letter_spacing.abs() > 1000.
            || !self.paragraph_spacing.is_finite()
            || !(0. ..=10000.).contains(&self.paragraph_spacing)
            || !self.paragraph_indent.is_finite()
            || self.paragraph_indent.abs() > 10000.
            || !["start", "center", "end", "justify"].contains(&self.align.as_str())
            || !["auto", "ltr", "rtl"].contains(&self.direction.as_str())
            || !["horizontal", "vertical"].contains(&self.writing_mode.as_str())
            || self.features.len() > 16
            || self.variations.len() > 16
            || self
                .features
                .iter()
                .any(|f| f.len() > 32 || f.chars().any(|c| !c.is_ascii_graphic()))
            || self.variations.iter().any(|v| {
                v.tag.len() != 4
                    || v.tag.chars().any(|c| !c.is_ascii_alphanumeric())
                    || v.tag == "wght"
                    || !v.value.is_finite()
                    || v.value.abs() > 10_000.
            })
            || self
                .features
                .iter()
                .any(|f| rustybuzz::Feature::from_str(f).is_err())
        {
            return Err("Invalid text style".into());
        }
        Ok(())
    }
}
pub fn validate_node(node: &Node) -> Result<(), String> {
    if let Some(style) = &node.text_style {
        style.validate()?;
    }
    if node.text.encode_utf16().count() > 100000 || node.text_runs.len() > 4096 {
        return Err("Text budget exceeded".into());
    }
    if node.text_runs.is_empty() {
        return Ok(());
    }
    let mut boundaries = BTreeSet::from([0]);
    let mut at = 0;
    for cluster in node.text.graphemes(true) {
        at += cluster.encode_utf16().count();
        boundaries.insert(at);
    }
    let mut end = 0;
    for run in &node.text_runs {
        if let Some(p) = &run.paragraph {
            p.validate()?;
        }
        if run.start < end
            || run
                .color
                .as_ref()
                .is_some_and(|c| crate::color::parse(c, Default::default()).is_err())
            || run.link.as_ref().is_some_and(|s| {
                s.len() > 4096
                    || !(s.starts_with("https://")
                        || s.starts_with("http://")
                        || s.starts_with("mailto:"))
            })
            || run.start >= run.end
            || !boundaries.contains(&run.start)
            || !boundaries.contains(&run.end)
            || run.font_id.as_ref().is_some_and(|id| !valid_font_id(id))
            || run
                .font_size
                .is_some_and(|v| !v.is_finite() || !(1. ..=4096.).contains(&v))
            || run
                .weight
                .is_some_and(|v| !v.is_finite() || !(1. ..=1000.).contains(&v))
            || run
                .letter_spacing
                .is_some_and(|v| !v.is_finite() || v.abs() > 1000.)
            || run
                .line_height
                .is_some_and(|v| !v.is_finite() || !(0.1..=10.).contains(&v))
        {
            return Err("Invalid text style range or grapheme boundary".into());
        }
        end = run.end;
    }
    Ok(())
}
/// Materialize styled outlines only in the renderer's derived document. The
/// authored text, ranges and UTF-16 identities remain in source_doc/history.
pub fn expand_rich_text(doc: &mut crate::scene::Document, fonts: &Fonts) -> Result<(), String> {
    let ids: Vec<_> = doc
        .nodes
        .values()
        .filter(|n| {
            n.kind == "text"
                && n.text_runs
                    .iter()
                    .any(|r| r.color.is_some() || r.underline || r.strikethrough)
        })
        .map(|n| n.id.clone())
        .collect();
    for id in ids {
        let original = doc.nodes[&id].clone();
        let layout =
            fonts.node_outline_layout(&original, Some(original.width), OutlineOutput::Spans)?;
        let mut children = Vec::new();
        for (i, span) in layout.spans.into_iter().enumerate() {
            if span.outline.commands.is_empty() {
                continue;
            }
            let mut n = original.clone();
            n.id = format!("{id}:text-span:{i}");
            n.kind = "vector".into();
            n.text_path = None;
            n.transform = Default::default();
            n.children.clear();
            n.effects.clear();
            n.opacity = 1.;
            n.blend = "normal".into();
            n.mask = false;
            n.clip = false;
            n.component = None;
            n.instance = None;
            n.instance_origin = None;
            n.component_key = None;
            n.bindings.clear();
            n.style_refs.clear();
            n.layout = None;
            n.sizing = None;
            n.constraints = None;
            n.text.clear();
            n.text_runs.clear();
            n.derived_path = Some(Arc::new(span.outline));
            n.network = Some(
                (crate::scene::Network {
                    vertices: vec![],
                    edges: vec![],
                    filled_faces: None,
                    fill_rule: "nonzero".into(),
                })
                .into(),
            );
            if let Some(color) = span.color {
                n.fills = vec![crate::scene::Paint {
                    id: String::new(),
                    kind: "solid".into(),
                    color,
                    opacity: 1.,
                    visible: true,
                    angle: 0.,
                    stops: vec![],
                    image: None,
                    fit: "cover".into(),
                    blend: "normal".into(),
                    adjust: None,
                    tile: None,
                    transform: None,
                }];
            }
            // Derived spans share the session's aggregate resource allowance;
            // a legacy 40k business threshold must not reject an admitted scene.
            // Per-text glyph/outline guards above remain independently bounded.
            crate::capacity::check_document_counts(
                doc.nodes
                    .len()
                    .saturating_add(usize::from(!doc.nodes.contains_key(&n.id))),
                doc.pages.len(),
            )?;
            children.push(n.id.clone());
            doc.nodes.insert(n.id.clone(), n);
        }
        let n = doc.nodes.get_mut(&id).unwrap();
        n.kind = "group".into();
        n.fills.clear();
        n.strokes.clear();
        n.children = children;
    }
    Ok(())
}
fn run_covering(runs: &[TextRun], cluster: usize) -> Option<&TextRun> {
    runs.get(
        runs.partition_point(|run| run.start <= cluster)
            .saturating_sub(1),
    )
    .filter(|run| run.start <= cluster && cluster < run.end)
}
fn cluster_tracking(runs: &[TextRun], cluster: usize, style: &TextStyle) -> f64 {
    run_covering(runs, cluster)
        .and_then(|run| run.letter_spacing)
        .unwrap_or(style.letter_spacing)
}
fn cluster_line_multiplier(runs: &[TextRun], cluster: usize, style: &TextStyle) -> f64 {
    run_covering(runs, cluster)
        .and_then(|run| run.line_height)
        .unwrap_or(style.line_height)
}
impl Fonts {
    pub fn new() -> Self {
        Self::default()
    }
    /// Toggle rendering-side glyph-origin quantisation (see the field
    /// documentation); layout and caret geometry never move.
    pub fn set_glyph_origin_quantization(&mut self, on: bool) {
        self.quantize_glyph_origins = on;
    }
    pub fn glyph_origin_quantization(&self) -> bool {
        self.quantize_glyph_origins
    }
    pub(crate) fn source_stamp(&self) -> FontSourceStamp {
        FontSourceStamp { default:self.data_digest, quantized:self.quantize_glyph_origins,
            named:self.named.iter().map(|(id,font)|(id.clone(),(font.digest,font.index))).collect() }
    }
    pub fn load(&mut self, data: &[u8]) -> Result<(), String> {
        check_font(data)?;
        self.data = Arc::new(data.to_vec());
        self.data_digest = Sha256::digest(data).into();
        self.text_paths = Default::default();
        Ok(())
    }
    pub fn with_resources(
        &self,
        resources: &BTreeMap<String, FontResource>,
    ) -> Result<Self, String> {
        if resources.len() > 32 {
            return Err("Document exceeds 32 fonts".into());
        }
        let mut next = Self {
            data: self.data.clone(),
            data_digest: self.data_digest,
            outlines: self.outlines.clone(),
            text_paths: Default::default(),
            faces: self.faces.clone(),
            shaped_runs: self.shaped_runs.clone(),
            named: BTreeMap::new(),
            quantize_glyph_origins: self.quantize_glyph_origins,
        };
        let mut total = 0;
        for (id, resource) in resources {
            if id == "default"
                || !valid_font_id(id)
                || resource.family.trim().is_empty()
                || resource.family.encode_utf16().count() > 200
            {
                return Err("Invalid font resource identity".into());
            }
            let digest: [u8; 32] = Sha256::digest(resource.data.as_bytes()).into();
            let font = if let Some(cached) = self
                .named
                .get(id)
                .filter(|f| f.digest == digest && f.index == resource.index)
            {
                cached.clone()
            } else {
                if resource.data.len() > 28 * 1024 * 1024 {
                    return Err("Font resource exceeds 20 MB decoded budget".into());
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(resource.data.as_bytes())
                    .map_err(|_| "Invalid font base64")?;
                if bytes.len() > 20 * 1024 * 1024 {
                    return Err("Font resource exceeds 20 MB".into());
                }
                // Validate the exact face the index selects: a collection with
                // a stale index must fail at install, not on first glyph.
                if ttf_parser::Face::parse(&bytes, resource.index).is_err() {
                    return Err(format!(
                        "Font face {} missing from resource {id}",
                        resource.index
                    ));
                }
                FontData {
                    bytes: Arc::new(bytes),
                    digest,
                    index: resource.index,
                }
            };
            total += font.bytes.len();
            if total > 24 * 1024 * 1024 {
                return Err("Document font resources exceed 24 MB".into());
            }
            next.named.insert(id.clone(), font);
        }
        if next.named.len() == self.named.len()
            && next.named.iter().all(|(id, font)| {
                self.named
                    .get(id)
                    .is_some_and(|old| old.digest == font.digest && old.index == font.index)
            })
        {
            next.text_paths = self.text_paths.clone();
        }
        Ok(next)
    }
    /// Raw font file bytes of one resource, shared with the vector PDF
    /// exporter's whole-file embedding.
    pub(crate) fn bytes(&self, id: &str) -> Result<&[u8], String> {
        if id == "default" {
            Ok(&self.data)
        } else {
            self.named
                .get(id)
                .map(|f| f.bytes.as_slice())
                .ok_or_else(|| format!("Missing font resource: {id}"))
        }
    }
    fn face(&self, id: &str, weight: f32) -> Result<Arc<ParsedFontFace>, String> {
        self.face_with(id, weight, &[])
    }
    fn face_index(&self, id: &str) -> u32 {
        if id == "default" {
            0
        } else {
            self.named.get(id).map_or(0, |f| f.index)
        }
    }
    fn face_with(
        &self,
        id: &str,
        weight: f32,
        extra: &[rustybuzz::Variation],
    ) -> Result<Arc<ParsedFontFace>, String> {
        let (bytes, digest, index) = if id == "default" {
            (&self.data, self.data_digest, 0)
        } else {
            let font = self
                .named
                .get(id)
                .ok_or_else(|| format!("Missing font resource: {id}"))?;
            (&font.bytes, font.digest, font.index)
        };
        let key = FontFaceKey {
            font: digest,
            index,
            weight: weight.to_bits(),
            axes: extra
                .iter()
                .map(|v| (v.tag.to_bytes(), v.value.to_bits()))
                .collect(),
        };
        if let Some(face) = self
            .faces
            .read()
            .map_err(|_| "Font face cache poisoned")?
            .inner
            .get(&key)
        {
            return Ok(face);
        }
        let face = ParsedFontFaceTryBuilder {
            key: key.clone(),
            bytes: bytes.clone(),
            face_builder: |bytes| {
                let mut face = rustybuzz::Face::from_slice(bytes, index)
                    .ok_or_else(|| format!("Font must be loaded: {id}"))?;
                let mut variations = vec![rustybuzz::Variation {
                    tag: ttf_parser::Tag::from_bytes(b"wght"),
                    value: weight,
                }];
                variations.extend_from_slice(extra);
                face.set_variations(&variations);
                Ok::<_, String>(face)
            },
        }
        .try_build()?;
        let charge = face.residency_charge();
        let mut cache = self.faces.write().map_err(|_| "Font face cache poisoned")?;
        cache.builds += 1;
        Ok(cache.inner.insert(key, face, charge))
    }
    fn shape_run(
        &self,
        face: &ParsedFontFace,
        text: &str,
        features: &[rustybuzz::Feature],
        buffer: rustybuzz::UnicodeBuffer,
    ) -> Result<Arc<ShapedRun>, String> {
        // Cache font-unit shaping only. Node ids, UTF-16 bases, size, spacing,
        // wrap/paragraph placement and outlines are applied afresh by layout.
        // Keep the actual resolved script/language/direction and feature ranges
        // in the key, rather than assuming all same-text runs shape alike.
        let key = ShapedRunKey {
            face: face.borrow_key().clone(),
            text: text.to_owned(),
            features: features
                .iter()
                .map(|f| (f.tag.to_bytes(), f.value, f.start, f.end))
                .collect(),
            direction: buffer.direction() as u8,
            script: buffer.script(),
            language: buffer.language(),
            flags: buffer.flags().bits(),
            cluster_level: buffer.cluster_level() as u8,
        };
        if let Some(shaped) = self
            .shaped_runs
            .read()
            .map_err(|_| "Shaping cache poisoned")?
            .inner
            .get(&key)
        {
            return Ok(shaped);
        }
        let shaped = rustybuzz::shape(face.borrow_face(), features, buffer);
        let value = ShapedRun {
            infos: shaped.glyph_infos().to_vec(),
            positions: shaped.glyph_positions().to_vec(),
        };
        let charge = 512
            + 2 * (key.text.capacity()
                + key.features.capacity() * 16
                + key.face.axes.capacity() * 12
                + key.language.as_ref().map_or(0, |l| l.as_str().len()))
            + value.infos.capacity() * std::mem::size_of::<rustybuzz::GlyphInfo>()
            + value.positions.capacity() * std::mem::size_of::<rustybuzz::GlyphPosition>();
        let mut cache = self
            .shaped_runs
            .write()
            .map_err(|_| "Shaping cache poisoned")?;
        cache.builds += 1;
        Ok(cache.inner.insert(key, value, charge))
    }
    /// Bounded derived-cache diagnostics; neither cache changes authored font
    /// identity, typography, layout precision or the fallback chain.
    pub fn shaping_cache_stats(&self) -> serde_json::Value {
        let stats = |cache: &FontFaceCache| {
            let mut v = cache.inner.stats();
            v["builds"] = cache.builds.into();
            v
        };
        let faces = self
            .faces
            .read()
            .map(|c| stats(&c))
            .unwrap_or_else(|_| serde_json::json!({"error":"Font face cache poisoned"}));
        let shapes = self
            .shaped_runs
            .read()
            .map(|c| {
                let mut v = c.inner.stats();
                v["builds"] = c.builds.into();
                v
            })
            .unwrap_or_else(|_| serde_json::json!({"error":"Shaping cache poisoned"}));
        serde_json::json!({"faces":faces,"runs":shapes})
    }
    fn style_variations(style: &TextStyle) -> Result<Vec<rustybuzz::Variation>, String> {
        style
            .variations
            .iter()
            .map(|v| {
                let bytes: &[u8; 4] = v.tag.as_bytes().try_into().expect("validated 4-byte tag");
                Ok(rustybuzz::Variation {
                    tag: ttf_parser::Tag::from_bytes(bytes),
                    value: v.value as f32,
                })
            })
            .collect()
    }
    /// Per-pixel smear for fake bold on static faces (see the outline loop).
    /// Zero when the face already exposes a `wght` axis or the weight does
    /// not ask for bold at all.
    fn synthetic_bold_delta(&self, has_weight_axis: bool, face_weight: f32, weight: f32, size: f64) -> f64 {
        if weight <= 550. || !(weight.is_finite() && size.is_finite() && size > 0.) {
            return 0.;
        }
        if has_weight_axis {
            return 0.;
        }
        // A static face that already is this weight class is the source
        // outline. Smearing it would no longer be those glyphs. A lighter
        // static face keeps the existing fake-bold amount.
        if face_weight >= 1. && face_weight + 50. >= weight {
            return 0.;
        }
        size * f64::from((weight - 500.).clamp(0., 500.)) / 500. * 0.04
    }
    pub fn glyph_cache_stats(&self) -> serde_json::Value {
        match self.outlines.read() {
            Ok(cache) => cache.stats(),
            Err(_) => serde_json::json!({"error":"Glyph cache poisoned"}),
        }
    }
    fn glyph_outline(
        &self,
        glyph: &Glyph,
    ) -> Result<Arc<crate::font_glyph_cache::Outline>, String> {
        use crate::font_glyph_cache::{Key, Outline};
        let digest = if glyph.font_id == "default" {
            self.data_digest
        } else {
            self.named
                .get(&glyph.font_id)
                .ok_or_else(|| format!("Missing font resource: {}", glyph.font_id))?
                .digest
        };
        let key = Key {
            font: digest,
            face: self.face_index(&glyph.font_id),
            glyph: glyph.id,
            weight: glyph.weight.to_bits(),
            axes: glyph
                .vars
                .iter()
                .map(|v| (v.tag.to_bytes(), v.value.to_bits()))
                .collect(),
        };
        if let Some(outline) = self
            .outlines
            .read()
            .map_err(|_| "Glyph cache poisoned")?
            .get(&key)
        {
            return Ok(outline);
        }
        let face = self.face_with(&glyph.font_id, glyph.weight, &glyph.vars)?;
        let face = face.borrow_face();
        let mut outline = Outline {
            units_per_em: face.units_per_em(),
            weight_axis: face.tables().fvar.is_some_and(|table| {
                table
                    .axes
                    .into_iter()
                    .any(|axis| axis.tag == ttf_parser::Tag::from_bytes(b"wght"))
            }),
            us_weight: face.weight().to_number(),
            ..Outline::default()
        };
        face.outline_glyph(ttf_parser::GlyphId(glyph.id), &mut outline);
        Ok(self
            .outlines
            .write()
            .map_err(|_| "Glyph cache poisoned")?
            .insert(key, outline))
    }
    /// Horizontal advance of `glyph` in font units, evaluated on the exact
    /// variation instance shaping used (weight plus style axes), so exported
    /// width tables agree with shaped advances on variable fonts. `None` when
    /// the face exposes no horizontal metric table.
    pub(crate) fn glyph_advance_units(&self, glyph: &Glyph) -> Option<u16> {
        let face = self
            .face_with(&glyph.font_id, glyph.weight, &glyph.vars)
            .ok()?;
        face.borrow_face()
            .glyph_hor_advance(ttf_parser::GlyphId(glyph.id))
    }
    pub fn path(&self, text: &str, size: f64) -> Result<Path, String> {
        Ok(self
            .layout(
                text,
                size,
                &TextStyle::default(),
                &[],
                None,
                OutlineOutput::Geometry,
                None,
            )?
            .path)
    }
    pub fn measure(&self, text: &str, size: f64) -> Result<(f64, f64), String> {
        let l = self.layout(
            text,
            size,
            &TextStyle::default(),
            &[],
            None,
            OutlineOutput::None,
            None,
        )?;
        Ok((l.width.max(0.01), l.height))
    }
    pub fn node_layout(&self, node: &Node, width: Option<f64>) -> Result<TextLayout, String> {
        self.node_outline_layout(node, width, OutlineOutput::Svg)
    }
    fn node_outline_layout(
        &self,
        node: &Node,
        width: Option<f64>,
        output: OutlineOutput,
    ) -> Result<TextLayout, String> {
        validate_node(node)?;
        let fallback;
        let style = match &node.text_style {
            Some(style) => style,
            None => {
                fallback = TextStyle::default();
                &fallback
            }
        };
        let mut result = self.layout(
            &node.text,
            node.font_size,
            style,
            &node.text_runs,
            width,
            output,
            node.text_path.as_deref(),
        )?;
        if style.writing_mode == "horizontal" && node.text_path.is_none() {
            let offset = (node.height - result.height).max(0.)
                * match style.vertical_align.as_str() {
                    "center" => 0.5,
                    "bottom" => 1.,
                    _ => 0.,
                };
            if offset != 0. {
                let matrix = crate::math::Transform([1., 0., 0., 1., 0., offset]);
                crate::text_path::transform_outline(&mut result.path, matrix);
                for span in &mut result.spans {
                    crate::text_path::transform_outline(&mut span.outline, matrix);
                    if output == OutlineOutput::Svg {
                        span.path = span.outline.svg_data();
                    }
                }
                for glyph in &mut result.glyphs {
                    glyph.y += offset;
                }
                for line in &mut result.lines {
                    line.y += offset;
                }
                if output == OutlineOutput::Svg {
                    result.bounds =
                        crate::bounds::path_bounds(&result.path, crate::math::Transform::default());
                }
            }
        }
        Ok(result)
    }
    pub fn node_measure(&self, node: &Node, width: Option<f64>) -> Result<TextLayout, String> {
        validate_node(node)?;
        let fallback;
        let style = match &node.text_style {
            Some(style) => style,
            None => {
                fallback = TextStyle::default();
                &fallback
            }
        };
        self.layout(
            &node.text,
            node.font_size,
            style,
            &node.text_runs,
            width,
            OutlineOutput::None,
            node.text_path.as_deref(),
        )
    }
    pub fn node_path(&self, node: &Node) -> Result<Path, String> {
        self.node_path_shared(node).map(|path| (*path).clone())
    }
    pub fn node_path_shared(&self, node: &Node) -> Result<Arc<Path>, String> {
        validate_node(node)?;
        let key = serde_json::to_vec(&(
            &node.text,
            node.font_size.to_bits(),
            node.width.to_bits(),
            node.height.to_bits(),
            &node.text_style,
            &node.text_runs,
            &node.text_path,
            self.quantize_glyph_origins,
        ))
        .map_err(|e| e.to_string())?;
        let cached = self
            .text_paths
            .read()
            .map_err(|_| "Text path cache poisoned")?
            .get(&key);
        if let Some(path) = cached {
            return Ok(path);
        }
        let path = self
            .node_outline_layout(node, Some(node.width), OutlineOutput::Geometry)?
            .path;
        let path = self
            .text_paths
            .write()
            .map_err(|_| "Text path cache poisoned")?
            .insert(key, path);
        Ok(path)
    }
    pub fn text_path_cache_stats(&self) -> serde_json::Value {
        match self.text_paths.read() {
            Ok(cache) => cache.stats(),
            Err(_) => serde_json::json!({"error":"Text path cache poisoned"}),
        }
    }
    /// Caret geometry at one UTF-16 offset. Offsets normally sit on grapheme
    /// boundaries (the grid `TextRun` ranges are validated against); an
    /// offset inside a grapheme snaps to that grapheme's start. A wrap
    /// boundary places the caret at the end of the earlier line.
    pub fn caret_at(&self, node: &Node, utf16_offset: usize) -> Result<Caret, String> {
        validate_node(node)?;
        if utf16_offset > node.text.encode_utf16().count() {
            return Err("Caret offset exceeds text length".into());
        }
        let style = node.text_style.clone().unwrap_or_default();
        let vertical = style.writing_mode == "vertical";
        let wrapped = vertical_wrap_engaged(&style, node);
        let layout = self.node_layout(node, Some(node.width))?;
        let line_index = layout
            .lines
            .partition_point(|l| l.end < utf16_offset)
            .min(layout.lines.len().saturating_sub(1));
        let Some(line) = layout.lines.get(line_index) else {
            return Ok(Caret {
                x: 0.,
                y: 0.,
                height: 0.,
                tilt: false,
            });
        };
        let glyphs: Vec<&Glyph> = layout
            .glyphs
            .iter()
            .filter(|g| line.start <= g.cluster && g.cluster < line.end)
            .collect();
        // The covering glyph is the first whose cluster ends after the
        // offset; interior offsets of a multi-glyph cluster resolve to the
        // cluster start.
        let covering = glyphs
            .iter()
            .copied()
            .find(|g| g.cluster_end > utf16_offset);
        let anchor = covering.or_else(|| glyphs.last().copied());
        if !vertical {
            return Ok(Caret {
                x: covering.map_or_else(|| anchor.map_or(0., |g| g.x + g.advance), |g| g.x),
                y: line.y,
                height: line.height,
                tilt: false,
            });
        }
        let boundary = covering.map_or_else(|| anchor.map_or(line.y, flow_end), flow_start);
        let column_x = if wrapped {
            layout.lines[..line_index].iter().map(|l| l.width).sum()
        } else {
            0.
        };
        Ok(Caret {
            x: column_x + line.width / 2.,
            y: boundary - line.width / 2.,
            height: line.width,
            tilt: anchor.is_some_and(|g| g.path_transform.is_some()),
        })
    }
    /// UTF-16 offset whose caret is nearest to a node-local point.
    /// Horizontal text selects the line by the point's y and the nearest
    /// boundary by x; vertical text scores columns on both axes (Chebyshev)
    /// because wrapped columns spread in x while unwrapped paragraphs stack
    /// in y. Offsets inside a grapheme never surface: hits resolve to
    /// cluster boundaries.
    pub fn hit_caret(&self, node: &Node, x: f64, y: f64) -> Result<usize, String> {
        validate_node(node)?;
        if !x.is_finite() || !y.is_finite() {
            return Err("Invalid caret hit point".into());
        }
        let style = node.text_style.clone().unwrap_or_default();
        let vertical = style.writing_mode == "vertical";
        let wrapped = vertical_wrap_engaged(&style, node);
        let layout = self.node_layout(node, Some(node.width))?;
        if layout.lines.is_empty() {
            return Ok(0);
        }
        let line_index = if vertical {
            let mut column_x = 0.;
            let mut best = (f64::INFINITY, 0);
            for (index, line) in layout.lines.iter().enumerate() {
                let left = column_x;
                if wrapped {
                    column_x += line.width;
                }
                let dx = (left - x).max(x - left - line.width).max(0.);
                let dy = (line.y - y).max(y - line.y - line.height).max(0.);
                let score = dx.max(dy);
                if score < best.0 {
                    best = (score, index);
                }
            }
            best.1
        } else {
            layout
                .lines
                .partition_point(|l| l.y + l.height <= y)
                .min(layout.lines.len() - 1)
        };
        let line = &layout.lines[line_index];
        let glyphs: Vec<&Glyph> = layout
            .glyphs
            .iter()
            .filter(|g| line.start <= g.cluster && g.cluster < line.end)
            .collect();
        let mut best = (f64::INFINITY, line.end);
        let mut consider = |offset: usize, position: f64| {
            let distance = (position - if vertical { y } else { x }).abs();
            if distance < best.0 {
                best = (distance, offset);
            }
        };
        for glyph in &glyphs {
            consider(
                glyph.cluster,
                if vertical { flow_start(glyph) } else { glyph.x },
            );
        }
        if let Some(last) = glyphs.last() {
            consider(
                line.end,
                if vertical {
                    flow_end(last)
                } else {
                    last.x + last.advance
                },
            );
        }
        Ok(best.1)
    }
    fn shape(
        &self,
        text: &str,
        base: usize,
        size: f64,
        style: &TextStyle,
        runs: &[TextRun],
        utf16: &[usize],
    ) -> Result<Vec<Glyph>, String> {
        if text.is_empty() {
            return Ok(vec![]);
        }
        let features: Vec<rustybuzz::Feature> = style
            .features
            .iter()
            .map(|f| rustybuzz::Feature::from_str(f))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Invalid text style".to_string())?;
        let variations = Self::style_variations(style)?;
        let bidi = unicode_bidi::BidiInfo::new(
            text,
            match style.direction.as_str() {
                "ltr" => Some(unicode_bidi::Level::ltr()),
                "rtl" => Some(unicode_bidi::Level::rtl()),
                _ => None,
            },
        );
        let (levels, visual) = bidi.visual_runs(&bidi.paragraphs[0], 0..text.len());
        let mut glyphs = Vec::new();
        // Avoid repeated cache lookups within a run, while keeping only bounded
        // owning references. Persistent entries are keyed by bytes/index/axes,
        // so resource replacement and cloned snapshots cannot reuse stale faces.
        let mut coverage_faces = HashMap::new();
        for range in visual {
            let rtl = levels[range.start].is_rtl();
            let mut pieces: Vec<(usize, usize, String, f64, f32, Option<usize>)> = Vec::new();
            for (offset, cluster) in text[range.clone()].grapheme_indices(true) {
                let start = range.start + offset;
                let position = utf16[base + start];
                let run = runs
                    .get(
                        runs.partition_point(|r| r.start <= position)
                            .saturating_sub(1),
                    )
                    .filter(|r| r.start <= position && position < r.end);
                let font_id = run
                    .and_then(|r| r.font_id.as_deref())
                    .unwrap_or(&style.font_id);
                let size = run.and_then(|r| r.font_size).unwrap_or(size);
                let weight = run.and_then(|r| r.weight).unwrap_or(style.weight);
                let mut chosen = None;
                // The chain always ends at the embedded default font (the
                // NotoSansSC resource the host installs): a Latin-only system
                // font must still render CJK instead of failing the canvas.
                let mut chain: Vec<&str> = Vec::with_capacity(style.fallbacks.len() + 2);
                chain.push(font_id);
                chain.extend(style.fallbacks.iter().map(String::as_str));
                if !self.data.is_empty() && !chain.iter().any(|id| *id == "default") {
                    chain.push("default");
                }
                for id in &chain {
                    // A resource that vanished from the document degrades to
                    // the next candidate; a genuinely unusable primary is
                    // reported by the shaping call below.
                    let key = (*id, weight.to_bits());
                    if coverage_faces.len() >= 64 && !coverage_faces.contains_key(&key) {
                        coverage_faces.clear();
                    }
                    let Some(face) = coverage_faces
                        .entry(key)
                        .or_insert_with(|| self.face(id, weight).ok())
                        .as_ref()
                    else {
                        continue;
                    };
                    if cluster.chars().all(|c| {
                        c.is_control()
                            || matches!(c, '\u{200c}' | '\u{200d}' | '\u{fe0e}' | '\u{fe0f}')
                            || face.borrow_face().glyph_index(c).is_some()
                    }) {
                        chosen = Some((*id).to_owned());
                        break;
                    }
                }
                // No face covers the cluster (e.g. emoji under a CJK default):
                // shape it on the primary font anyway — uncovered code points
                // become .notdef boxes exactly like a native text stack, and
                // one stray character can no longer blank the whole render.
                let id = chosen.unwrap_or_else(|| font_id.to_owned());
                if let Some(last) = pieces.last_mut().filter(|p| {
                    p.1 == start
                        && p.2 == id
                        && p.3 == size
                        && p.4 == weight
                        && p.5 == run.map(|r| r.start)
                }) {
                    last.1 += cluster.len();
                } else {
                    pieces.push((
                        start,
                        start + cluster.len(),
                        id,
                        size,
                        weight,
                        run.map(|r| r.start),
                    ));
                }
            }
            if rtl {
                pieces.reverse();
            }
            for (start, end, id, size, weight, _) in pieces {
                let face = self.face_with(&id, weight, &variations)?;
                let scale = size / face.borrow_face().units_per_em() as f64;
                let mut buffer = rustybuzz::UnicodeBuffer::new();
                buffer.push_str(&text[start..end]);
                buffer.guess_segment_properties();
                buffer.set_direction(if rtl {
                    rustybuzz::Direction::RightToLeft
                } else {
                    rustybuzz::Direction::LeftToRight
                });
                let shaped = self.shape_run(&face, &text[start..end], &features, buffer)?;
                for (index, (glyph, p)) in shaped.infos.iter().zip(&shaped.positions).enumerate() {
                    let last_in_cluster = shaped
                        .infos
                        .get(index + 1)
                        .is_none_or(|next| next.cluster != glyph.cluster);
                    let cluster = utf16[base + start + glyph.cluster as usize];
                    glyphs.push(Glyph {
                        path_transform: None,
                        id: glyph.glyph_id as u16,
                        font_id: id.clone(),
                        size,
                        weight,
                        cluster,
                        cluster_end: 0,
                        x: p.x_offset as f64 * scale,
                        y: -p.y_offset as f64 * scale,
                        advance: (p.x_advance as f64 * scale).abs()
                            + if last_in_cluster {
                                cluster_tracking(runs, cluster, style)
                            } else {
                                0.
                            },
                        byte: base + start + glyph.cluster as usize,
                        vars: variations.clone(),
                    });
                }
            }
        }
        Ok(glyphs)
    }
    #[allow(clippy::too_many_arguments)]
    fn layout(
        &self,
        text: &str,
        size: f64,
        style: &TextStyle,
        runs: &[TextRun],
        width: Option<f64>,
        output: OutlineOutput,
        text_path: Option<&crate::text_path::TextPath>,
    ) -> Result<TextLayout, String> {
        if style.text_case == TextCase::Original
            && runs
                .iter()
                .all(|r| r.text_case.is_none_or(|c| c == TextCase::Original))
        {
            return self.layout_raw(text, size, style, runs, width, output, text_path);
        }
        let display = crate::text_case::display_text(text, style.text_case, runs);
        let mut result = self.layout_raw(
            &display.text,
            size,
            style,
            &display.runs,
            width,
            output,
            text_path,
        )?;
        for glyph in &mut result.glyphs {
            glyph.cluster = display.starts[glyph.cluster];
            glyph.cluster_end = display.ends[glyph.cluster_end];
        }
        for line in &mut result.lines {
            line.start = display.starts[line.start];
            line.end = display.ends[line.end];
        }
        Ok(result)
    }
    fn layout_raw(
        &self,
        text: &str,
        size: f64,
        style: &TextStyle,
        runs: &[TextRun],
        width: Option<f64>,
        output: OutlineOutput,
        text_path: Option<&crate::text_path::TextPath>,
    ) -> Result<TextLayout, String> {
        style.validate()?;
        if !size.is_finite() || size <= 0. || size > 4096. || text.len() > 400000 {
            return Err("Invalid text layout inputs".into());
        }
        let baseline = text_path.map(crate::text_path::Baseline::new).transpose()?;
        let width = baseline.as_ref().map(|b| b.length).or(width);
        // Wrapping engages for both writing modes: horizontally the `width`
        // parameter is the line budget; vertically it is the COLUMN HEIGHT
        // budget (design convention: vertical wrap constrains how deep one
        // column flows before a new column opens to the right).
        let limit = width.filter(|_| style.wrap && baseline.is_none());
        if limit.is_some_and(|w| !w.is_finite() || w <= 0.) {
            return Err("Invalid text width".into());
        }
        let mut utf16 = vec![0; text.len() + 1];
        let mut pos = 0;
        for (byte, c) in text.char_indices() {
            utf16[byte] = pos;
            pos += c.len_utf16();
        }
        utf16[text.len()] = pos;
        let mut lines = Vec::new();
        let mut glyphs = Vec::new();
        let mut y = 0.;
        // Pen for vertical wrapping: filled columns advance in +x with no
        // gap (the column width is the tallest glyph size).
        let mut column_x = 0.;
        let mut widest = 0f64;
        let mut start = 0;
        let mut paragraphs = Vec::new();
        for (byte, c) in text.char_indices() {
            if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                if c == '\n' && byte > 0 && text.as_bytes()[byte - 1] == b'\r' {
                    start = byte + 1;
                    continue;
                }
                paragraphs.push(start..byte);
                start = byte + c.len_utf8();
            }
        }
        paragraphs.push(start..text.len());
        for paragraph in paragraphs {
            let attributes = runs
                .iter()
                .find(|r| r.start <= utf16[paragraph.start] && utf16[paragraph.start] < r.end)
                .and_then(|r| r.paragraph.as_ref());
            let mut paragraph_style;
            let style = if let Some(p) = attributes {
                p.validate()?;
                paragraph_style = style.clone();
                paragraph_style.align = p.align.clone();
                paragraph_style.paragraph_spacing = p.spacing;
                paragraph_style.paragraph_indent = p.indent;
                &paragraph_style
            } else {
                style
            };
            let value = &text[paragraph.clone()];
            let initial = self.shape(value, paragraph.start, size, style, runs, &utf16)?;
            let mut clusters = BTreeMap::<usize, f64>::new();
            for glyph in &initial {
                *clusters.entry(glyph.byte).or_default() += glyph.advance;
            }
            let mut ranges = Vec::new();
            if let Some(maximum) = limit.filter(|_| !clusters.is_empty()) {
                let breaks: BTreeSet<_> = unicode_linebreak::linebreaks(value)
                    .map(|(p, _)| paragraph.start + p)
                    .collect();
                let entries: Vec<_> = clusters.into_iter().collect();
                let mut begin = 0;
                while begin < entries.len() {
                    let mut end = begin;
                    let mut advance = 0.;
                    let mut legal = None;
                    while end < entries.len() {
                        // Compare occupied width directly: subtracting the
                        // inset from an exact-fit Hug width can round down.
                        if end > begin
                            && advance + entries[end].1 - style.letter_spacing
                                + if begin == 0 {
                                    style.paragraph_indent.max(0.)
                                } else {
                                    0.
                                }
                                > maximum
                        {
                            break;
                        }
                        advance += entries[end].1;
                        end += 1;
                        let byte = entries.get(end).map_or(paragraph.end, |e| e.0);
                        if breaks.contains(&byte) {
                            legal = Some(end);
                        }
                    }
                    if end < entries.len() {
                        end = legal.filter(|i| *i > begin).unwrap_or(end);
                    }
                    let from = if begin == 0 {
                        paragraph.start
                    } else {
                        entries[begin].0
                    };
                    let to = entries.get(end).map_or(paragraph.end, |e| e.0);
                    ranges.push(from..to);
                    begin = end;
                }
            } else {
                ranges.push(paragraph.clone());
            }
            let mut initial = Some(initial);
            for range in ranges {
                let mut shaped = if range == paragraph {
                    initial.take().expect("whole paragraph is one line")
                } else {
                    self.shape(&text[range.clone()], range.start, size, style, runs, &utf16)?
                };
                if style.writing_mode == "vertical" {
                    // Conventional mixed vertical layout: CJK stays upright in
                    // its em cell; other runs rotate a quarter turn clockwise
                    // so their reading direction points down. The column
                    // width is the tallest glyph size; upright baselines sit
                    // one ascent into the column so bodies share [0..size].
                    //
                    // With wrapping engaged each filled range is one column
                    // (TextLine per column, `y` at the column top, `width`
                    // the column width) and columns advance in +x with no
                    // gap; the first column of a paragraph insets the budget
                    // like a horizontal first-line indent. Without a budget
                    // the historical paragraph stacking in +y is preserved.
                    //
                    // Boundary grid for the caret APIs: vertical lines carry
                    // the same next-cluster offsets as horizontal ones.
                    let mut boundaries: Vec<usize> = shaped.iter().map(|g| g.cluster).collect();
                    boundaries.push(utf16[range.end]);
                    boundaries.sort_unstable();
                    boundaries.dedup();
                    for glyph in &mut shaped {
                        glyph.cluster_end = boundaries[boundaries
                            .partition_point(|p| *p <= glyph.cluster)
                            .min(boundaries.len() - 1)];
                    }
                    let wrapped = limit.is_some();
                    let column = shaped.iter().map(|g| g.size).fold(0f64, f64::max);
                    let base = if wrapped {
                        if range.start == paragraph.start {
                            style.paragraph_indent.max(0.)
                        } else {
                            0.
                        }
                    } else {
                        y
                    };
                    let mut run_y = base;
                    let mut run_x = 0.;
                    let mut upright_run = None::<bool>;
                    for glyph in &mut shaped {
                        let upright = text[glyph.byte..]
                            .chars()
                            .next()
                            .is_some_and(upright_in_vertical);
                        if upright_run != Some(upright) && upright_run.is_some() {
                            // Close the rotated run: its horizontal sequence
                            // becomes downward extent.
                            run_y += run_x;
                            run_x = 0.;
                        }
                        upright_run = Some(upright);
                        if upright {
                            let face = self.face_with(&glyph.font_id, glyph.weight, &glyph.vars)?;
                            let face = face.borrow_face();
                            let ascent =
                                face.ascender() as f64 * glyph.size / face.units_per_em() as f64;
                            glyph.x = ascent.max(0.);
                            glyph.y = run_y + glyph.size;
                            run_y += glyph.advance.max(0.);
                        } else {
                            glyph.x = run_x;
                            glyph.y = run_y;
                            // Map the positioned horizontal outline into the
                            // column: reading direction (+x) becomes +y and
                            // the glyph's up direction becomes +x.
                            glyph.path_transform =
                                Some(crate::math::Transform([0., 1., -1., 0., glyph.y, -glyph.x]));
                            run_x += glyph.advance.max(0.);
                        }
                    }
                    run_y += run_x;
                    if wrapped {
                        // Slide the column-local glyphs into their slot.
                        for glyph in &mut shaped {
                            glyph.x += column_x;
                            if let Some(matrix) = &mut glyph.path_transform {
                                matrix.0[5] -= column_x;
                            }
                        }
                    }
                    let height = if wrapped {
                        run_y.max(column)
                    } else {
                        (run_y - base).max(column)
                    };
                    lines.push(TextLine {
                        start: utf16[range.start],
                        end: utf16[range.end],
                        width: column,
                        y: if wrapped { 0. } else { y },
                        height,
                    });
                    if wrapped {
                        widest = widest.max(column_x + column);
                        y = y.max(height);
                        column_x += column;
                    } else {
                        widest = widest.max(column);
                        y += height;
                    }
                    glyphs.extend(shaped);
                    if glyphs.len() > 200000 || lines.len() > 100000 {
                        return Err("Text layout work budget exceeded".into());
                    }
                    continue;
                }
                let mut ascent = if shaped.is_empty() || attributes.is_some() {
                    0.
                } else {
                    // Seed the line box with the style font's ascent floor; a
                    // resource that vanished from the document degrades to the
                    // fonts the line actually shaped onto.
                    let face = self
                        .face(&style.font_id, style.weight)
                        .or_else(|_| self.face(&shaped[0].font_id, shaped[0].weight))?;
                    let face = face.borrow_face();
                    face.ascender() as f64 * size / face.units_per_em() as f64
                };
                let explicit_line_height = shaped.iter().any(|glyph| {
                    run_covering(runs, glyph.cluster).is_some_and(|run| run.line_height.is_some())
                });
                // Without a run override the node font size remains the line-box
                // floor, including when every glyph is smaller than that size.
                let mut height = if explicit_line_height {
                    0.
                } else {
                    size * style.line_height
                };
                let mut natural = 0f64;
                for glyph in &shaped {
                    let face = self.face(&glyph.font_id, glyph.weight)?;
                    let face = face.borrow_face();
                    ascent = ascent
                        .max(face.ascender() as f64 * glyph.size / face.units_per_em() as f64);
                    let multiplier = if explicit_line_height {
                        cluster_line_multiplier(runs, glyph.cluster, style)
                    } else {
                        style.line_height
                    };
                    height = height.max(glyph.size * multiplier);
                    natural = natural.max(
                        (face.ascender() as f64 - face.descender() as f64 + face.line_gap() as f64)
                            * glyph.size
                            / face.units_per_em() as f64,
                    );
                }
                if let Some(p) = attributes {
                    if shaped.is_empty() {
                        let face = self.face(&style.font_id, style.weight)?;
                        let face = face.borrow_face();
                        natural = (face.ascender() as f64 - face.descender() as f64
                            + face.line_gap() as f64)
                            * size
                            / face.units_per_em() as f64;
                        ascent = face.ascender() as f64 * size / face.units_per_em() as f64;
                    }
                    height = natural.max(p.minimum_line_height);
                    if p.maximum_line_height > 0. {
                        height = height.min(p.maximum_line_height);
                    }
                    // Center the font metrics in the constrained line box.
                    // Keep unrounded document-space values; raster sampling stays unchanged.
                    ascent += (height - natural) / 2.;
                }
                let trailing = shaped
                    .last()
                    .map(|glyph| cluster_tracking(runs, glyph.cluster, style))
                    .unwrap_or(0.);
                let line_width = (shaped.iter().map(|g| g.advance).sum::<f64>() - trailing).max(0.);
                let available = width.unwrap_or(line_width);
                let rtl = style.direction == "rtl"
                    || (style.direction == "auto"
                        && unicode_bidi::BidiInfo::new(&text[range.clone()], None)
                            .paragraphs
                            .first()
                            .is_some_and(|p| p.level.is_rtl()));
                let mut x = match style.align.as_str() {
                    "center" => (available - line_width) / 2.,
                    "end" if !rtl => available - line_width,
                    "start" if rtl => available - line_width,
                    _ => 0.,
                };
                let mut boundaries: Vec<_> = shaped.iter().map(|g| g.cluster).collect();
                if range.start == paragraph.start {
                    x += style.paragraph_indent;
                }
                let spaces = shaped
                    .iter()
                    .filter(|g| text[g.byte..].starts_with(' '))
                    .count();
                let extra = if style.align == "justify" && range.end < paragraph.end && spaces > 0 {
                    (available - line_width).max(0.) / spaces as f64
                } else {
                    0.
                };
                boundaries.push(utf16[range.end]);
                boundaries.sort_unstable();
                boundaries.dedup();
                for glyph in &mut shaped {
                    glyph.cluster_end = boundaries[boundaries
                        .partition_point(|p| *p <= glyph.cluster)
                        .min(boundaries.len() - 1)];
                    glyph.x += x;
                    glyph.y += y + ascent;
                    x += glyph.advance;
                    if text[glyph.byte..].starts_with(' ') {
                        glyph.advance += extra;
                        x += extra;
                    }
                }
                lines.push(TextLine {
                    start: utf16[range.start],
                    end: utf16[range.end],
                    width: line_width,
                    y,
                    height,
                });
                // Intrinsic width reserves the same positive first-line inset
                // as wrapping. TextLine.width remains the shaped advance;
                // negative (hanging) indentation keeps its existing overflow.
                let inset = if range.start == paragraph.start {
                    style.paragraph_indent.max(0.)
                } else {
                    0.
                };
                widest = widest.max(line_width + inset);
                y += height;
                glyphs.extend(shaped);
                if glyphs.len() > 200000 || lines.len() > 100000 {
                    return Err("Text layout work budget exceeded".into());
                }
            }
            if paragraph.end < text.len() {
                if limit.is_some() && style.writing_mode == "vertical" {
                    // Vertical block flow runs horizontally: paragraph gaps
                    // open between columns.
                    column_x += style.paragraph_spacing;
                } else {
                    y += style.paragraph_spacing;
                }
            }
        }
        let mut path = Path::default();
        let mut spans: Vec<TextSpan> = Vec::new();
        for glyph in glyphs.iter_mut().filter(|_| output != OutlineOutput::None) {
            let run = runs
                .iter()
                .find(|r| r.start <= glyph.cluster && glyph.cluster < r.end);
            let color = run.and_then(|r| r.color.clone());
            let link = run.and_then(|r| r.link.clone());
            let mut outline = Path::default();
            let glyph_outline = self.glyph_outline(glyph)?;
            // Static faces without a `wght` axis ignore weight shaping
            // entirely; synthesize bold with the classic four-way sub-pixel
            // outline smear (QuickDraw fake bold). Advances stay shaped, so
            // layout, wrapping and exported width tables are unaffected.
            let bold = self.synthetic_bold_delta(
                glyph_outline.weight_axis,
                f32::from(glyph_outline.us_weight),
                glyph.weight,
                glyph.size,
            );
            let offsets: &[(f64, f64)] = if bold > 0. {
                &[(0., 0.), (bold, 0.), (0., bold), (bold, bold)]
            } else {
                &[(0., 0.)]
            };
            for (ox, oy) in offsets {
                let (mut place_x, mut place_y) = (glyph.x + ox, glyph.y + oy);
                if self.quantize_glyph_origins {
                    place_x = place_x.round_ties_even();
                    place_y = place_y.round_ties_even();
                }
                let mut builder = Builder {
                    path: &mut outline,
                    x: place_x,
                    y: place_y,
                    scale: glyph.size / glyph_outline.units_per_em as f64,
                };
                glyph_outline.replay(&mut builder);
            }
            for (enabled, offset) in [
                (run.is_some_and(|r| r.underline), glyph.size * 0.1),
                (run.is_some_and(|r| r.strikethrough), -glyph.size * 0.3),
            ] {
                if enabled {
                    let x = glyph.x;
                    let y = glyph.y + offset;
                    let h = (glyph.size / 16.).max(0.5);
                    outline.commands.extend(
                        Path::polygon(
                            &[
                                Point::new(x, y),
                                Point::new(x + glyph.advance, y),
                                Point::new(x + glyph.advance, y + h),
                                Point::new(x, y + h),
                            ],
                            true,
                        )
                        .commands,
                    );
                }
            }
            if let (Some(baseline), Some(binding)) = (&baseline, text_path) {
                let along = glyph.x + glyph.advance / 2. + binding.offset;
                if along < 0. || along > baseline.length {
                    continue;
                }
                let matrix = baseline
                    .pose(along, binding.normal)
                    .concat(crate::math::Transform([
                        1.,
                        0.,
                        0.,
                        1.,
                        -glyph.x - glyph.advance / 2.,
                        -glyph.y,
                    ]));
                glyph.path_transform = Some(matrix);
                crate::text_path::transform_outline(&mut outline, matrix);
            } else if let Some(matrix) = glyph.path_transform {
                crate::text_path::transform_outline(&mut outline, matrix);
            }
            if output == OutlineOutput::Geometry {
                path.commands.extend(outline.commands);
            } else {
                path.commands.extend(outline.commands.clone());
                if let Some(span) = spans
                    .last_mut()
                    .filter(|s| s.color == color && s.link == link)
                {
                    span.outline.commands.extend(outline.commands);
                } else {
                    spans.push(TextSpan {
                        path: String::new(),
                        color,
                        link,
                        outline,
                    });
                }
            }
            if path.commands.len() > 2_000_000 {
                return Err("Text outline work budget exceeded".into());
            }
        }
        Ok(TextLayout {
            spans: spans
                .into_iter()
                .map(|mut s| {
                    if output == OutlineOutput::Svg {
                        s.path = s.outline.svg_data();
                    }
                    s
                })
                .collect(),
            width: widest,
            height: y,
            lines,
            glyphs,
            bounds: if output == OutlineOutput::Svg {
                crate::bounds::path_bounds(&path, crate::math::Transform::default())
            } else {
                None
            },
            path,
        })
    }
}
/// Whether vertical wrapping engages for a node: mirrors the `layout`
/// budget predicate (wrap requested, no text path, a positive finite width
/// acting as the column-height budget).
fn vertical_wrap_engaged(style: &TextStyle, node: &Node) -> bool {
    style.writing_mode == "vertical"
        && style.wrap
        && node.text_path.is_none()
        && node.width.is_finite()
        && node.width > 0.
}
/// Flow-direction position of a glyph's leading boundary in vertical
/// writing: upright glyphs measure from the top of their em cell, rotated
/// runs from the run's shared top.
fn flow_start(glyph: &Glyph) -> f64 {
    if glyph.path_transform.is_some() {
        glyph.y
    } else {
        glyph.y - glyph.size
    }
}
/// Flow-direction position after a glyph's advance.
fn flow_end(glyph: &Glyph) -> f64 {
    if glyph.path_transform.is_some() {
        glyph.y + glyph.advance
    } else {
        glyph.y - glyph.size + glyph.advance
    }
}
/// Scripts and punctuation that stay upright in vertical writing; everything
/// else rotates. Ranges follow the conventional CJK vertical repertoire.
fn upright_in_vertical(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x303F          // CJK radicals, CJK punctuation
        | 0x3041..=0x30FF        // kana
        | 0x31F0..=0x31FF        // kana supplements
        | 0x3400..=0x4DBF        // CJK ext A
        | 0x4E00..=0x9FFF        // CJK unified
        | 0xF900..=0xFAFF        // CJK compat
        | 0x1100..=0x11FF        // Hangul jamo
        | 0x3130..=0x318F        // Hangul compat jamo
        | 0xA960..=0xA97F        // Hangul ext A
        | 0xAC00..=0xD7A3        // Hangul syllables
        | 0xFF00..=0xFF60        // fullwidth forms
        | 0x2018 | 0x2019 | 0x201C | 0x201D
        | 0x2025 | 0x2026        // ellipses
    )
}
fn check_font(data: &[u8]) -> Result<(), String> {
    if data.len() > 32 * 1024 * 1024 || ttf_parser::Face::parse(data, 0).is_err() {
        Err("Unsupported or oversized font".into())
    } else {
        Ok(())
    }
}
struct Builder<'a> {
    path: &'a mut Path,
    x: f64,
    y: f64,
    scale: f64,
}
impl Builder<'_> {
    fn p(&self, x: f32, y: f32) -> Point {
        Point::new(
            self.x + x as f64 * self.scale,
            self.y - y as f64 * self.scale,
        )
    }
}
impl ttf_parser::OutlineBuilder for Builder<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.path.commands.push(Command::Move(self.p(x, y)));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.path.commands.push(Command::Line(self.p(x, y)));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.path
            .commands
            .push(Command::Quad(self.p(x1, y1), self.p(x, y)));
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.path
            .commands
            .push(Command::Cubic(self.p(x1, y1), self.p(x2, y2), self.p(x, y)));
    }
    fn close(&mut self) {
        self.path.commands.push(Command::Close);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font_bytes() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap()
    }
    fn fonts() -> Fonts {
        let mut fonts = Fonts::new();
        fonts.load(&font_bytes()).unwrap();
        fonts
    }
    fn node(text: &str, style: serde_json::Value, width: f64) -> Node {
        serde_json::from_value(serde_json::json!({
            "id":"t", "kind":"text", "text":text, "fontSize":20,
            "width":width, "height":800, "textStyle":style,
            "fills":[{"kind":"solid","color":"#112233"}]
        }))
        .unwrap()
    }
    fn line_glyphs<'a>(layout: &'a TextLayout, line: &TextLine) -> Vec<&'a Glyph> {
        layout
            .glyphs
            .iter()
            .filter(|g| line.start <= g.cluster && g.cluster < line.end)
            .collect()
    }
    #[test]
    fn bundled_noto_sans_sc_reports_variable_weight_axis() {
        let faces: Vec<serde_json::Value> =
            serde_json::from_str(&faces_json(&font_bytes()).unwrap()).unwrap();
        assert_eq!(faces.len(), 1);
        let face = &faces[0];
        // Legacy name ID 1 stays available for existing importers.
        assert!(face["family"].as_str().unwrap_or("").contains("Noto Sans"));
        assert_eq!(face["variable"], true);
        assert!(face["typographicFamily"]
            .as_str()
            .unwrap_or("")
            .contains("Noto Sans"));
        let wght = face["axes"]
            .as_array()
            .and_then(|axes| axes.iter().find(|axis| axis["tag"] == "wght"))
            .expect("wght axis");
        assert!(wght["min"].as_f64().unwrap() <= 200.);
        assert!(wght["max"].as_f64().unwrap() >= 700.);
        assert!((1..=1000).contains(&face["weight"].as_u64().unwrap()));
    }
    fn round_trip(fonts: &Fonts, node: &Node, offset: usize) {
        let caret = fonts.caret_at(node, offset).unwrap();
        let hit = fonts
            .hit_caret(node, caret.x, caret.y + caret.height / 2.)
            .unwrap();
        assert_eq!(hit, offset, "caret at offset {offset} round trips");
    }

    #[test]
    fn run_tracking_and_line_height_override_node_metrics() {
        let fonts = fonts();
        let plain = node(
            "AB",
            serde_json::json!({"letterSpacing": 0, "lineHeight": 1.35}),
            400.,
        );
        let base = fonts.node_layout(&plain, Some(400.)).unwrap();
        let mut tracked = plain.clone();
        tracked.text_runs.push(TextRun {
            start: 0,
            end: 1,
            letter_spacing: Some(8.),
            ..TextRun::default()
        });
        let layout = fonts.node_layout(&tracked, Some(400.)).unwrap();
        assert!(
            (layout.lines[0].width - base.lines[0].width - 8.).abs() < 1e-6,
            "tracking on the first cluster widens the line by that many pixels"
        );
        let mut tall = plain.clone();
        tall.text_runs.push(TextRun {
            start: 1,
            end: 2,
            line_height: Some(2.),
            ..TextRun::default()
        });
        let layout = fonts.node_layout(&tall, Some(400.)).unwrap();
        assert!((base.lines[0].height - 27.).abs() < 1e-6);
        assert!(
            (layout.lines[0].height - 40.).abs() < 1e-6,
            "a 2× run override replaces the 1.35 node floor"
        );
    }

    #[test]
    fn missing_coverage_degrades_instead_of_failing_the_canvas() {
        let fonts = fonts();
        // NotoSansSC carries no emoji: the cluster must shape as .notdef on
        // the default face instead of erroring the whole render.
        let emoji = node("😀字", serde_json::json!({}), 200.);
        let layout = fonts.node_layout(&emoji, Some(200.)).unwrap();
        assert_eq!(layout.glyphs.len(), 2, "both clusters shape");
        // A style pointing at a resource that vanished from the document
        // falls back to the embedded default rather than hard-failing.
        let missing = node("中文", serde_json::json!({"fontId":"nope"}), 200.);
        let layout = fonts.node_layout(&missing, Some(200.)).unwrap();
        assert!(
            layout.glyphs.iter().all(|g| g.font_id == "default"),
            "missing resource degrades to the default face"
        );
    }

    #[test]
    fn vertical_wrap_breaks_a_long_run_into_columns() {
        let fonts = fonts();
        let text = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸";
        let n = node(
            text,
            serde_json::json!({"writingMode":"vertical","wrap":true}),
            100.,
        );
        let layout = fonts.node_layout(&n, Some(100.)).unwrap();
        // Pinned NotoSansSC CJK advance of 20: five glyphs per 100-unit
        // column budget, four columns for twenty glyphs.
        assert_eq!(layout.lines.len(), 4);
        assert!(
            layout.lines.iter().all(|l| l.y == 0.),
            "wrapped columns start at the top"
        );
        let total: f64 = layout.lines.iter().map(|l| l.width).sum();
        assert!(
            (layout.width - total).abs() < 1e-6,
            "layout width is the full column extent"
        );
        for line in &layout.lines {
            assert!(line.height <= 100. + 1e-6, "column honors the budget");
            let column = line_glyphs(&layout, line);
            assert!(!column.is_empty());
            // Upright baselines sit one ascent into their column, so the
            // assertion is separation, not containment: every glyph of a
            // column precedes every glyph of the next.
            let maximum = column.iter().map(|g| g.x).fold(f64::MIN, f64::max);
            let next = layout
                .glyphs
                .iter()
                .filter(|g| line.end <= g.cluster && g.cluster < text.encode_utf16().count())
                .map(|g| g.x)
                .fold(f64::MAX, f64::min);
            if next < f64::MAX {
                assert!(
                    maximum < next,
                    "column glyphs precede the next column ({maximum} < {next})"
                );
            }
            for pair in column.windows(2) {
                assert!(pair[1].y > pair[0].y, "flow advances downward");
            }
        }
    }

    #[test]
    fn horizontal_caret_round_trips_start_middle_and_end() {
        let fonts = fonts();
        let text = "中文排版换行测试";
        let n = node(text, serde_json::json!({"wrap":true}), 40.);
        let layout = fonts.node_layout(&n, Some(40.)).unwrap();
        assert!(layout.lines.len() >= 2, "text wraps first");
        for offset in [
            0,
            1,
            layout.lines[0].end,
            layout.lines[1].end,
            text.encode_utf16().count(),
        ] {
            round_trip(&fonts, &n, offset);
        }
    }

    #[test]
    fn vertical_caret_round_trips_top_middle_and_bottom() {
        let fonts = fonts();
        let text = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸";
        let n = node(
            text,
            serde_json::json!({"writingMode":"vertical","wrap":true}),
            100.,
        );
        let layout = fonts.node_layout(&n, Some(100.)).unwrap();
        assert!(layout.lines.len() >= 2, "text wraps first");
        for offset in [0, 2, layout.lines[0].end, text.encode_utf16().count()] {
            round_trip(&fonts, &n, offset);
        }
    }

    #[test]
    fn caret_tilt_marks_rotated_latin_and_invalid_inputs_error() {
        let fonts = fonts();
        let mixed = node(
            "测试AV设计",
            serde_json::json!({"writingMode":"vertical"}),
            500.,
        );
        assert!(
            !fonts.caret_at(&mixed, 1).unwrap().tilt,
            "CJK boundary is upright"
        );
        assert!(
            fonts.caret_at(&mixed, 3).unwrap().tilt,
            "Latin run boundary tilts"
        );
        assert!(fonts.caret_at(&mixed, 99).is_err());
        assert!(fonts.hit_caret(&mixed, f64::NAN, 0.).is_err());
        assert!(fonts.hit_caret(&mixed, 0., f64::INFINITY).is_err());
        // Empty text still yields a usable caret: a degenerate line box at
        // the origin with the default line height.
        let empty = node("", serde_json::json!({}), 40.);
        assert_eq!(fonts.hit_caret(&empty, 3., 4.).unwrap(), 0);
        let caret = fonts.caret_at(&empty, 0).unwrap();
        assert_eq!((caret.x, caret.y), (0., 0.));
        assert_eq!(caret.height, 20. * 1.35);
    }
}

#[cfg(test)]
mod glyph_quantization_tests {
    use super::*;

    fn text_node(spacing: f64) -> Node {
        serde_json::from_value(serde_json::json!({
            "id":"t", "kind":"text", "text":"iii",
            "width":300, "height":40,
            "fontSize":32, "letterSpacing":spacing,
            "fills":[{"kind":"solid","color":"#112233"}]
        }))
        .unwrap()
    }

    fn move_x_fracts(fonts: &Fonts, node: &Node) -> Vec<f64> {
        let path = fonts.node_path(node).expect("text path");
        path.commands
            .iter()
            .filter_map(|c| match c {
                crate::path::Command::Move(p) => Some(p.x.fract().abs()),
                _ => None,
            })
            .collect()
    }

    fn font_bytes() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap()
    }

    #[test]
    fn quantization_snaps_painted_origins_but_not_layout() {
        let mut fonts = Fonts::new();
        fonts.load(&font_bytes()).expect("font");
        let node = text_node(0.33);
        let default_fracts = move_x_fracts(&fonts, &node);
        let default_layout: Vec<f64> = fonts
            .node_layout(&node, Some(node.width))
            .expect("layout")
            .glyphs
            .iter()
            .map(|g| g.x)
            .collect();
        assert!(
            default_layout.iter().any(|x| x.fract().abs() > 1e-9),
            "fractional letter spacing must produce fractional pen origins"
        );
        assert!(
            default_fracts.len() > 2 && default_fracts.iter().filter(|f| **f > 1e-9).count() >= 2,
            "default painted origins carry the fractional pen"
        );
        fonts.set_glyph_origin_quantization(true);
        let quantized_fracts = move_x_fracts(&fonts, &node);
        let distinct = |fracts: &[f64]| -> usize {
            let mut sorted = fracts.to_vec();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
            sorted.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
            sorted.len()
        };
        // "i" paints two contours per glyph: with snapped origins only the
        // two per-contour offsets survive as fractional parts.
        assert!(
            distinct(&quantized_fracts) <= 2,
            "quantised contour starts must cluster on the per-contour offsets"
        );
        // Layout never moves: the shaped pen is untouched by the flag.
        let quantized_layout: Vec<f64> = fonts
            .node_layout(&node, Some(node.width))
            .expect("layout")
            .glyphs
            .iter()
            .map(|g| g.x)
            .collect();
        assert_eq!(quantized_layout, default_layout);
        // Toggling off restores the exact default painted path.
        fonts.set_glyph_origin_quantization(false);
        assert_eq!(move_x_fracts(&fonts, &node), default_fracts);
    }
}

#[cfg(test)]
mod shared_path_tests {
    use super::*;
    #[test]
    fn text_outline_hits_share_owners_and_font_reload_invalidates_them() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap();
        let mut fonts = Fonts::new();
        fonts.load(&bytes).unwrap();
        let mut node:Node=serde_json::from_value(serde_json::json!({"id":"text","kind":"text","text":"Cache 中文 ffi","fontSize":24,"width":300,"height":50})).unwrap();
        let a = fonts.node_path_shared(&node).unwrap();
        let b = fonts.node_path_shared(&node).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(*a, fonts.node_path(&node).unwrap());
        node.id = "moved".into();
        node.transform.0[4] = 17.375;
        node.opacity = 0.5;
        assert!(Arc::ptr_eq(&a, &fonts.node_path_shared(&node).unwrap()));
        node.font_size = 25.;
        assert!(!Arc::ptr_eq(&a, &fonts.node_path_shared(&node).unwrap()));
        node.font_size = 24.;
        fonts.load(&bytes).unwrap();
        assert!(!Arc::ptr_eq(&a, &fonts.node_path_shared(&node).unwrap()));
    }
    #[test]
    fn preloaded_font_engines_share_font_bytes_but_keep_request_state_isolated() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap();
        let mut fonts = Fonts::new();
        fonts.load(&bytes).unwrap();
        let mut a = crate::Engine::with_fonts(fonts.clone());
        let mut b = crate::Engine::with_fonts(fonts.clone());
        let document = |color: &str| {
            serde_json::json!({"schemaVersion":1,"id":"request","name":"request","pages":[{"id":"p","name":"p","background":"#ffffff","children":["r"]}],"nodes":{"r":{"id":"r","kind":"rectangle","width":8,"height":8,"fills":[{"kind":"solid","color":color}]}}}).to_string()
        };
        a.load_document(&document("#ff0000")).unwrap();
        b.load_document(&document("#00ff00")).unwrap();
        assert!(Arc::ptr_eq(&a.fonts.data, &b.fonts.data));
        assert!(Arc::ptr_eq(&fonts.data, &a.fonts.data));
        let options: crate::RenderOptions = serde_json::from_value(
            serde_json::json!({"pageId":"p","width":8,"height":8,"view":{"x":0,"y":0,"zoom":1}}),
        )
        .unwrap();
        assert_eq!(&a.render(&options).unwrap()[..4], &[255, 0, 0, 255]);
        assert_eq!(&b.render(&options).unwrap()[..4], &[0, 255, 0, 255]);
        a.load_font(&bytes).unwrap();
        assert!(!Arc::ptr_eq(&a.fonts.data, &b.fonts.data));
        assert!(Arc::ptr_eq(&fonts.data, &b.fonts.data));
    }
}

#[cfg(test)]
mod persistent_font_cache_tests {
    use super::*;

    fn bytes() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap()
    }
    fn fonts() -> Fonts {
        let mut fonts = Fonts::new();
        fonts.load(&bytes()).unwrap();
        fonts
    }
    fn uncached(fonts: &Fonts) -> Fonts {
        let mut result = fonts.clone();
        result.faces = Arc::new(RwLock::new(FontFaceCache {
            inner: crate::read_cache::ReadCache::new(0, 0),
            builds: 0,
        }));
        result.shaped_runs = Arc::new(RwLock::new(ShapedRunCache {
            inner: crate::read_cache::ReadCache::new(0, 0),
            builds: 0,
        }));
        result.outlines = Default::default();
        result.text_paths = Default::default();
        result
    }
    fn node(text: &str, style: serde_json::Value) -> Node {
        serde_json::from_value(serde_json::json!({
            "id":"text", "kind":"text", "text":text,
            "fontSize":19.25, "width":89.5, "height":200,
            "textStyle":style,
        }))
        .unwrap()
    }
    fn assert_layout_equal(cached: &Fonts, reference: &Fonts, node: &Node) {
        let a = cached
            .node_outline_layout(node, Some(node.width), OutlineOutput::Svg)
            .unwrap();
        let b = reference
            .node_outline_layout(node, Some(node.width), OutlineOutput::Svg)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::to_value(&b).unwrap()
        );
        assert_eq!(a.path, b.path);
        for offset in [0, node.text.encode_utf16().count()] {
            assert_eq!(
                serde_json::to_value(cached.caret_at(node, offset).unwrap()).unwrap(),
                serde_json::to_value(reference.caret_at(node, offset).unwrap()).unwrap()
            );
        }
    }
    fn shaped_signature(run: &ShapedRun) -> Vec<(u32, u32, i32, i32, i32, i32)> {
        run.infos
            .iter()
            .zip(&run.positions)
            .map(|(i, p)| {
                (
                    i.glyph_id,
                    i.cluster,
                    p.x_advance,
                    p.y_advance,
                    p.x_offset,
                    p.y_offset,
                )
            })
            .collect()
    }
    fn buffer(text: &str, rtl: bool, language: &str) -> rustybuzz::UnicodeBuffer {
        let mut buffer = rustybuzz::UnicodeBuffer::new();
        buffer.push_str(text);
        buffer.guess_segment_properties();
        buffer.set_direction(if rtl {
            rustybuzz::Direction::RightToLeft
        } else {
            rustybuzz::Direction::LeftToRight
        });
        buffer.set_language(language.parse().unwrap());
        buffer
    }

    #[test]
    fn repeated_layout_reuses_faces_and_shapes_without_changing_output() {
        let fonts = fonts();
        let reference = uncached(&fonts);
        let cases = [
            node("AV ffi 中 e\u{301} 😀", serde_json::json!({})),
            node(
                "AV ffi 中字",
                serde_json::json!({"weight":725,"features":["-kern","-liga"]}),
            ),
            node(
                "中文AV文字\n下一行",
                serde_json::json!({"wrap":true,"letterSpacing":0.375,"paragraphIndent":7.25,"paragraphSpacing":3.5}),
            ),
            node(
                "中文AV文字下一行",
                serde_json::json!({"writingMode":"vertical","wrap":true}),
            ),
            node(
                "abc שלום العربية 字",
                serde_json::json!({"direction":"rtl"}),
            ),
            node(
                "中文 fallback",
                serde_json::json!({"fontId":"missing","fallbacks":["also-missing"]}),
            ),
            node(
                "aBc ß 中",
                serde_json::json!({"textCase":"upper","align":"center"}),
            ),
        ];
        for n in &cases {
            assert_layout_equal(&fonts, &reference, n);
        }
        let n = &cases[0];
        let before = fonts.shaping_cache_stats();
        for _ in 0..3 {
            fonts.node_layout(n, Some(n.width)).unwrap();
        }
        let after = fonts.shaping_cache_stats();
        assert_eq!(before["faces"]["builds"], after["faces"]["builds"]);
        assert_eq!(before["runs"]["builds"], after["runs"]["builds"]);
        assert!(
            after["faces"]["hits"].as_u64().unwrap() > before["faces"]["hits"].as_u64().unwrap()
        );
        assert!(after["runs"]["hits"].as_u64().unwrap() > before["runs"]["hits"].as_u64().unwrap());
        let mut rich = node("ffi中文AV", serde_json::json!({"letterSpacing":0.25}));
        rich.text_runs = vec![TextRun {
            start: 0,
            end: 3,
            font_size: Some(31.5),
            weight: Some(850.),
            ..Default::default()
        }]
        .into();
        assert_layout_equal(&fonts, &reference, &rich);
    }

    #[test]
    fn shaping_keys_include_axes_features_ranges_direction_script_and_language() {
        let fonts = fonts();
        let a = fonts.face("default", 400.).unwrap();
        assert!(Arc::ptr_eq(
            &a,
            &fonts.clone().face("default", 400.).unwrap()
        ));
        let b = fonts.face("default", 800.).unwrap();
        assert!(!Arc::ptr_eq(&a, &b));
        let axes = [rustybuzz::Variation {
            tag: ttf_parser::Tag::from_bytes(b"wdth"),
            value: 75.,
        }];
        let c = fonts.face_with("default", 400., &axes).unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        let text = "AV ffi 字";
        let features = vec![rustybuzz::Feature::from_str("kern[0:2]=0").unwrap()];
        let first = fonts
            .shape_run(&a, text, &features, buffer(text, false, "en"))
            .unwrap();
        assert!(Arc::ptr_eq(
            &first,
            &fonts
                .shape_run(&a, text, &features, buffer(text, false, "en"))
                .unwrap()
        ));
        let cases = [
            (&a, features.clone(), false, "zh"),
            (&a, features.clone(), true, "en"),
            (&a, vec![], false, "en"),
            (&b, features.clone(), false, "en"),
            (&c, features.clone(), false, "en"),
            (
                &a,
                vec![rustybuzz::Feature::from_str("kern[1:3]=0").unwrap()],
                false,
                "en",
            ),
        ];
        for (face, features, rtl, language) in cases {
            let cached = fonts
                .shape_run(face, text, &features, buffer(text, rtl, language))
                .unwrap();
            assert!(!Arc::ptr_eq(&first, &cached));
            let direct =
                rustybuzz::shape(face.borrow_face(), &features, buffer(text, rtl, language));
            assert_eq!(
                shaped_signature(&cached),
                shaped_signature(&ShapedRun {
                    infos: direct.glyph_infos().to_vec(),
                    positions: direct.glyph_positions().to_vec(),
                })
            );
        }
        let mut changed_script = buffer(text, false, "en");
        changed_script.set_script(rustybuzz::script::ARABIC);
        assert!(!Arc::ptr_eq(
            &first,
            &fonts
                .shape_run(&a, text, &features, changed_script)
                .unwrap()
        ));
    }

    // Build a small TTC wrapper with two directories sharing all font data,
    // except the second face has an independently stored hhea ascent. This
    // exercises selected collection-face identity without a system font.
    fn collection(mut font: Vec<u8>) -> Vec<u8> {
        let tables = usize::from(u16::from_be_bytes(font[4..6].try_into().unwrap()));
        let directory_len = 12 + tables * 16;
        let hhea = (0..tables)
            .map(|i| 12 + i * 16)
            .find(|i| &font[*i..*i + 4] == b"hhea")
            .unwrap();
        let hhea_offset =
            u32::from_be_bytes(font[hhea + 8..hhea + 12].try_into().unwrap()) as usize;
        let hhea_len = u32::from_be_bytes(font[hhea + 12..hhea + 16].try_into().unwrap()) as usize;
        let mut alternate_hhea = font[hhea_offset..hhea_offset + hhea_len].to_vec();
        let ascent = i16::from_be_bytes(alternate_hhea[4..6].try_into().unwrap());
        alternate_hhea[4..6].copy_from_slice(&(ascent - 31).to_be_bytes());
        for i in 0..tables {
            let offset = 12 + i * 16 + 8;
            let value = u32::from_be_bytes(font[offset..offset + 4].try_into().unwrap()) + 20;
            font[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
        }
        let second_offset = (20 + font.len() + 3) & !3;
        let alternate_offset = second_offset + directory_len;
        let mut second = font[..directory_len].to_vec();
        second[hhea + 8..hhea + 12].copy_from_slice(&(alternate_offset as u32).to_be_bytes());
        let mut output = b"ttcf\0\x01\0\0\0\0\0\x02".to_vec();
        output.extend_from_slice(&20u32.to_be_bytes());
        output.extend_from_slice(&(second_offset as u32).to_be_bytes());
        output.extend(font);
        output.resize(second_offset, 0);
        output.extend(second);
        output.extend(alternate_hhea);
        output
    }

    #[test]
    fn font_reload_resource_replacement_and_collection_index_are_isolated() {
        let mut fonts = fonts();
        let original = fonts.clone();
        let a = fonts.face("default", 400.).unwrap();
        let ttc = collection(bytes());
        let resource = |index| FontResource {
            family: "Test".into(),
            data: base64::engine::general_purpose::STANDARD
                .encode(&ttc)
                .into(),
            index,
            postscript: None,
        };
        let mut resources = BTreeMap::from([("named".into(), resource(0))]);
        let first = fonts.with_resources(&resources).unwrap();
        let face0 = first.face("named", 400.).unwrap();
        assert!(Arc::ptr_eq(
            &face0,
            &first
                .with_resources(&resources)
                .unwrap()
                .face("named", 400.)
                .unwrap()
        ));
        resources.insert("named".into(), resource(1));
        let second = first.with_resources(&resources).unwrap();
        let face1 = second.face("named", 400.).unwrap();
        assert!(!Arc::ptr_eq(&face0, &face1));
        assert_ne!(
            face0.borrow_face().ascender(),
            face1.borrow_face().ascender()
        );
        assert_layout_equal(
            &second,
            &uncached(&second),
            &node("中文 AV", serde_json::json!({"fontId":"named"})),
        );
        fonts.load(&ttc).unwrap();
        let replaced = fonts.face("default", 400.).unwrap();
        assert!(!Arc::ptr_eq(&a, &replaced));
        assert!(Arc::ptr_eq(&a, &original.face("default", 400.).unwrap()));
        assert_layout_equal(
            &fonts,
            &uncached(&fonts),
            &node("reload 字", serde_json::json!({})),
        );
        let removed = second.with_resources(&BTreeMap::new()).unwrap();
        assert!(removed.face("named", 400.).is_err());
        assert_layout_equal(
            &removed,
            &uncached(&removed),
            &node("中文", serde_json::json!({"fontId":"named"})),
        );
    }

    #[test]
    fn caches_are_bounded_send_sync_and_eviction_keeps_live_owners_valid() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Fonts>();
        assert_send_sync::<ParsedFontFace>();
        let mut fonts = fonts();
        fonts.faces = Arc::new(RwLock::new(FontFaceCache {
            inner: crate::read_cache::ReadCache::new(128 * 1024 * 1024, 2),
            builds: 0,
        }));
        fonts.shaped_runs = Arc::new(RwLock::new(ShapedRunCache {
            inner: crate::read_cache::ReadCache::new(4096, 2),
            builds: 0,
        }));
        let weak_bytes = Arc::downgrade(&fonts.data);
        let held = fonts.face("default", 400.).unwrap();
        for weight in [500., 600., 700., 800., 900.] {
            fonts.face("default", weight).unwrap();
        }
        assert_eq!(fonts.shaping_cache_stats()["faces"]["entries"], 2);
        assert!(held.borrow_face().glyph_index('字').is_some());
        let rebuilt = fonts.face("default", 400.).unwrap();
        assert!(!Arc::ptr_eq(&held, &rebuilt));
        for text in ["one", "two", "three", "four"] {
            fonts
                .shape_run(&held, text, &[], buffer(text, false, "en"))
                .unwrap();
        }
        assert_eq!(fonts.shaping_cache_stats()["runs"]["entries"], 2);
        let large = "over budget".repeat(1000);
        let run = fonts
            .shape_run(&held, &large, &[], buffer(&large, false, "en"))
            .unwrap();
        assert!(!run.infos.is_empty());
        assert!(
            fonts.shaping_cache_stats()["runs"]["bytes"]
                .as_u64()
                .unwrap()
                <= 4096
        );
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let fonts = &fonts;
                scope.spawn(move || {
                    fonts.measure("thread 字", 20.).unwrap();
                });
            }
        });
        drop(rebuilt);
        drop(fonts);
        assert!(
            weak_bytes.upgrade().is_some(),
            "live face retains its backing bytes after eviction and Fonts drop"
        );
        assert!(held.borrow_face().glyph_index('字').is_some());
        drop(held);
        assert!(
            weak_bytes.upgrade().is_none(),
            "last face drop releases its backing bytes without a leak"
        );
    }

    fn poppins_v2(style: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../frontend/design-client/public/fonts/poppins/v2.000/Poppins-{style}.ttf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// FIG `01有料素材.fig` stored these em advances for "Back to Home"
    /// (textCase UPPER, Poppins Bold digest 45dc28c4…, 13px). They are the
    /// independent reference, not this shaper's previous output.
    const FIG_BACK_TO_HOME: [f64; 12] = [
        0.6740000247955322,
        0.7130000591278076,
        0.7640000581741333,
        0.7200000286102295,
        0.30000001192092896,
        0.6080000400543213,
        0.7880000472068787,
        0.30000001192092896,
        0.7630000114440918,
        0.7880000472068787,
        0.9450000524520874,
        0.5720000267028809,
    ];

    #[test]
    fn poppins_v2_bold_matches_fig_advances_and_keeps_its_own_outline() {
        let mut fonts = Fonts::new();
        fonts.load(&poppins_v2("Bold")).unwrap();
        let mut sized = node(
            "Back to Home",
            serde_json::json!({"weight":700,"fontId":"default","textCase":"upper","wrap":false}),
        );
        sized.font_size = 13.;
        sized.width = 400.;
        let layout = fonts.node_layout(&sized, Some(400.)).unwrap();
        assert_eq!(layout.glyphs.len(), FIG_BACK_TO_HOME.len());
        for (glyph, expected) in layout.glyphs.iter().zip(FIG_BACK_TO_HOME) {
            let em = glyph.advance / 13.;
            assert!(
                (em - expected).abs() <= 0.001,
                "glyph {} em {em} fig {expected}",
                glyph.cluster
            );
        }
        let bold = fonts
            .node_layout(
                &node("B", serde_json::json!({"weight":700,"fontId":"default"})),
                None,
            )
            .unwrap();
        let book = fonts
            .node_layout(
                &node("B", serde_json::json!({"weight":400,"fontId":"default"})),
                None,
            )
            .unwrap();
        assert!(
            bold.path.commands.len() > 4,
            "source outline should contain a contour"
        );
        assert_eq!(
            bold.path.commands.len(),
            book.path.commands.len(),
            "weight 700 on the Bold file must not smear a second copy of the outline"
        );
        let mut other = Fonts::new();
        other
            .load(
                &std::fs::read(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../frontend/design-client/public/fonts/poppins/Poppins-Bold.ttf"
                ))
                .unwrap(),
            )
            .unwrap();
        let v4 = other.node_layout(&sized, Some(400.)).unwrap();
        let space = v4.glyphs[4].advance / 13.;
        assert!(
            (space - FIG_BACK_TO_HOME[4]).abs() > 0.05,
            "version 4 space {space} must stay distinct from the FIG advance"
        );
    }

    #[test]
    fn poppins_v2_medium_keeps_the_fig_line_break() {
        let mut fonts = Fonts::new();
        fonts.load(&poppins_v2("Medium")).unwrap();
        let text = "To keep connected with us please login with your personal info.";
        let mut sample = node(
            text,
            serde_json::json!({"weight":500,"fontId":"default","wrap":true}),
        );
        sample.font_size = 14.;
        sample.width = 294.;
        let layout = fonts.node_layout(&sample, Some(294.)).unwrap();
        let ends: Vec<usize> = layout.lines.iter().map(|line| line.end).collect();
        assert_eq!(ends, vec![39, text.len()]);
    }
}
