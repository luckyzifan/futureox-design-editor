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
    /// An explicitly fixed line height remains in pixels when the font size changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height_pixels: Option<f64>,
    /// Empty keeps the historical unrounded half-leading baseline. `nearest-point`
    /// is the Sketch fixed line box used by native text-preview matrices.
    /// `sketch-font-leading` uses the font ascender and includes font leading
    /// in the advance for the original Sketch spacing modes 0 and 1.
    /// `sketch-fixed-advance` uses the ascender with an exact line advance.
    /// `figma-pixel-leading` centers the font metrics in an explicit FIG
    /// pixel line box, using the existing fractional baseline.
    /// `figma-font-metrics` keeps the intrinsic line advance of FIG Auto.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub line_box_baseline: String,
    /// Automatic line boxes use the selected font's line metrics.
    /// Sketch uses its original 1.35 sentinel for a default line box.
    #[serde(default, skip_serializing_if = "is_false")]
    pub line_height_auto: bool,
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
    /// Empty means this layer is not a list. `bullet` and `ordered` are the
    /// Figma list styles. Paragraphs can override this.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub list: String,
    /// Explicit indent level, 0 through 4. Absent inherits the first level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_level: Option<u8>,
    /// FIG-authored list spacing. Plain paragraph layout uses paragraph_spacing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_spacing: Option<f64>,
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
fn is_false(value: &bool) -> bool {
    !*value
}
fn valid_list(list: &str, level: Option<u8>, allow_none: bool) -> bool {
    let known = matches!(list, "" | "bullet" | "ordered") || (allow_none && list == "none");
    known
        && match (list, level) {
            ("", None) | ("none", None) => true,
            ("bullet" | "ordered", None | Some(0..=4)) => true,
            _ => false,
        }
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
            line_height_pixels: None,
            line_box_baseline: String::new(),
            line_height_auto: false,
            letter_spacing: 0.,
            wrap: false,
            align: "start".into(),
            direction: "auto".into(),
            features: vec![],
            variations: vec![],
            writing_mode: "horizontal".into(),
            list: String::new(),
            list_level: None,
            list_spacing: None,
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
    /// `none` clears an inherited layer list. Empty inherits it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub list: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_level: Option<u8>,
}
impl Default for TextParagraph {
    fn default() -> Self {
        Self {
            align: "start".into(),
            minimum_line_height: 0.,
            maximum_line_height: 0.,
            spacing: 0.,
            indent: 0.,
            list: String::new(),
            list_level: None,
        }
    }
}
impl TextParagraph {
    pub(crate) fn fixed_line_height(&self) -> Option<f64> {
        (self.minimum_line_height > 0. && (self.minimum_line_height - self.maximum_line_height).abs() <= 1e-9)
            .then_some(self.minimum_line_height)
    }

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
            || !valid_list(&self.list, self.list_level, true)
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
    pub italic: bool,
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

/// Host-owned faces used only to resolve non-embedded Sketch source names.
/// They never enter `Document::fonts`, so saving, `.sketch` round-trips, PDF
/// text operators and package bytes keep the portable embedded font contract.
#[derive(Clone, Default)]
struct LocalFonts {
    faces: BTreeMap<String, FontData>,
    /// Compacted PostScript/family/style name to internal face id.
    names: BTreeMap<String, String>,
    total_bytes: usize,
}

fn host_font_id(digest: [u8; 32], index: u32) -> String {
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{HOST_FONT_ID_PREFIX}{hex}-{index}")
}

fn compact_font_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-' | '\u{00a0}'))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn checked_face_name(value: &str) -> Option<&str> {
    let text = value.trim();
    (!text.is_empty() && !text.chars().any(char::is_control) && text.chars().count() <= 200)
        .then_some(text)
}

fn ascii_mac_roman_name(name: ttf_parser::name::Name<'_>) -> Option<&str> {
    if name.platform_id != ttf_parser::PlatformId::Macintosh
        || name.encoding_id != 0
        || !name.name.is_ascii()
    {
        return None;
    }
    checked_face_name(std::str::from_utf8(name.name).ok()?)
}

fn face_name_value(face: &ttf_parser::Face<'_>, ids: &[u16]) -> Option<String> {
    for id in ids {
        let mut fallback = None;
        for name in face.names().into_iter().filter(|name| name.name_id == *id) {
            let Some(text) = name.to_string() else { continue };
            let Some(text) = checked_face_name(&text) else { continue };
            if name.language_id == 0x0409 {
                return Some(text.into());
            }
            if fallback.is_none() {
                fallback = Some(text.into());
            }
        }
        if fallback.is_some() {
            return fallback;
        }
    }
    // Some installed faces keep family and PostScript names only in Mac
    // Roman. Its ASCII range is shared with UTF-8. Preserve Unicode choices
    // above and decline legacy bytes we cannot decode exactly.
    for id in ids {
        if let Some(text) = face
            .names()
            .into_iter()
            .filter(|name| name.name_id == *id)
            .find_map(ascii_mac_roman_name)
        {
            return Some(text.into());
        }
    }
    None
}

/// All portable identities a source face may be requested by.
fn face_name_keys(face: &ttf_parser::Face<'_>) -> BTreeSet<String> {
    let family = face_name_value(
        face,
        &[
            ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
            ttf_parser::name_id::FAMILY,
        ],
    );
    let style = face_name_value(
        face,
        &[
            ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY,
            ttf_parser::name_id::SUBFAMILY,
        ],
    );
    let postscript = face_name_value(face, &[ttf_parser::name_id::POST_SCRIPT_NAME]);
    let mut keys = BTreeSet::new();
    for name in family.iter().chain(postscript.iter()) {
        let key = compact_font_name(name);
        if !key.is_empty() {
            keys.insert(key);
        }
    }
    if let (Some(family), Some(style)) = (&family, &style) {
        for separator in [" ", ""] {
            let key = compact_font_name(&format!("{family}{separator}{style}"));
            if !key.is_empty() {
                keys.insert(key);
            }
        }
    }
    keys
}

/// Rank a face against a requested source name. PostScript is the most exact
/// identity; a bare family name prefers its Regular/Book/Normal cut instead of
/// whichever collection face happens to come first.
fn source_face_rank(face: &ttf_parser::Face<'_>, wanted: &str) -> Option<u8> {
    let family = face_name_value(
        face,
        &[
            ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
            ttf_parser::name_id::FAMILY,
        ],
    )
    .map(|name| compact_font_name(&name));
    let style = face_name_value(
        face,
        &[
            ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY,
            ttf_parser::name_id::SUBFAMILY,
        ],
    )
    .map(|name| compact_font_name(&name));
    let postscript = face_name_value(face, &[ttf_parser::name_id::POST_SCRIPT_NAME])
        .map(|name| compact_font_name(&name));
    if postscript.as_deref() == Some(wanted) {
        return Some(0);
    }
    if let (Some(family), Some(style)) = (&family, &style)
        && compact_font_name(&format!("{family} {style}")) == wanted
    {
        return Some(1);
    }
    if family.as_deref() == Some(wanted) {
        return Some(match style.as_deref() {
            Some("regular" | "book" | "normal") => 2,
            _ => 3,
        });
    }
    face_name_keys(face).contains(wanted).then_some(4)
}

/// Minimal view of the retained import binding. It deliberately accepts the
/// extra `fallbacks` key that the full provenance model does not store.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
struct SketchSourceNames {
    #[serde(default)]
    style: Option<String>,
    #[serde(default)]
    runs: BTreeMap<String, String>,
    #[serde(default)]
    fallbacks: Vec<String>,
}

impl SketchSourceNames {
    fn from_node(node: &Node) -> Option<Self> {
        let raw = node.bindings.get("sketchSourceFonts")?;
        serde_json::from_str(raw).ok()
    }
}

/// Collect retained source names from Sketch's node metadata first, then from
/// the typed design-system provenance and finally any legacy node binding.
/// The document is only read; nothing is injected into authored nodes.
fn sketch_source_names_by_node(
    document: &crate::scene::Document,
) -> BTreeMap<String, SketchSourceNames> {
    let mut names = BTreeMap::new();
    if let Some(system) = &document.design_system {
        if let Some(metadata) = system
            .sketch_containers
            .get("nodeMetadata")
            .and_then(serde_json::Value::as_object)
        {
            for (id, entry) in metadata {
                let raw = entry
                    .get("bindings")
                    .and_then(|bindings| bindings.get("sketchSourceFonts"))
                    .and_then(serde_json::Value::as_str);
                if let Some(source) = raw.and_then(|raw| serde_json::from_str(raw).ok()) {
                    names.insert(id.clone(), source);
                }
            }
        }
        for (id, source) in &system.font_sources {
            if names.contains_key(id) || (source.style.is_none() && source.runs.is_empty()) {
                continue;
            }
            names.insert(
                id.clone(),
                SketchSourceNames {
                    style: source.style.clone(),
                    runs: source.runs.clone(),
                    fallbacks: Vec::new(),
                },
            );
        }
    }
    for node in document.nodes.values() {
        if node.kind != "text" || names.contains_key(&node.id) {
            continue;
        }
        if let Some(source) = SketchSourceNames::from_node(node) {
            names.insert(node.id.clone(), source);
        }
    }
    names
}

/// Explicit host-supplied local face payload. `data` is base64, matching the
/// document font resource wire shape so hosts can reuse their reader.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalFontInput {
    family: String,
    #[serde(default)]
    postscript: Option<String>,
    data: String,
    #[serde(default)]
    index: u32,
}

// Internal shaping IDs cannot be stored as document font resources. The
// locally installed typeface never joins the document's transferable fonts.
#[cfg(target_os = "macos")]
mod macos_outlines;
#[cfg(not(target_arch = "wasm32"))]
mod local_sources;

const SKETCH_UI_TEXT_ID: &str = "\0sketch-ui-han-text";
const SKETCH_UI_DISPLAY_ID: &str = "\0sketch-ui-han-display";
const HOST_FONT_ID_PREFIX: &str = "\0host:";
const MAX_HOST_FONT_BYTES: usize = 20 * 1024 * 1024;
const MAX_HOST_FONTS: usize = 16;
const MAX_HOST_FONT_TOTAL_BYTES: usize = 64 * 1024 * 1024;

#[cfg(target_os = "macos")]
fn system_sketch_ui_face(id: &str) -> Option<&'static FontData> {
    const PATH: &str = "/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved/PingFangUI.ttc";
    static FACES: std::sync::OnceLock<Option<[FontData; 2]>> = std::sync::OnceLock::new();
    if !matches!(id, SKETCH_UI_TEXT_ID | SKETCH_UI_DISPLAY_ID) {
        return None;
    }
    let faces = FACES.get_or_init(|| {
        use std::io::Read as _;
        if !macos_outlines::available() { return None; }
        // CoreText resolves regular Simplified Chinese to these two UI
        // optical faces at 16 and 46 pt. Discover their active collection
        // indices at runtime because the order can change with macOS.
        let mut data = Vec::new();
        let limit = 96 * 1024 * 1024;
        let mut source = std::fs::File::open(PATH).ok()?.take(limit + 1);
        source.read_to_end(&mut data).ok()?;
        if data.len() as u64 > limit { return None; }
        let find = |instance: &str, variable_face: &str| (0..ttf_parser::fonts_in_collection(&data)?).find(|&index| {
            ttf_parser::Face::parse(&data, index).is_ok_and(|face| {
                let regular_axis = face.variation_axes().into_iter().any(|axis| {
                    axis.tag == ttf_parser::Tag::from_bytes(b"wght") &&
                        axis.min_value <= 400. && axis.max_value >= 400.
                });
                face.names().into_iter().any(|item| {
                    if item.name_id != ttf_parser::name_id::POST_SCRIPT_NAME { return false; }
                    let name = item.to_string();
                    name.as_deref() == Some(instance) || regular_axis && name.as_deref() == Some(variable_face)
                })
            })
        });
        // Modern macOS exposes Regular as the wght=400 instance of
        // -Default. Some older installations expose it as a static face.
        let text = find(".PingFangUITextSC-Regular", ".PingFangUITextSC-Default")?;
        let display = find(".PingFangUIDisplaySC-Regular", ".PingFangUIDisplaySC-Default")?;
        let digest = Sha256::digest(&data).into();
        let bytes = Arc::new(data);
        Some([
            FontData { bytes: bytes.clone(), digest, index: text },
            FontData { bytes, digest, index: display },
        ])
    }).as_ref()?;
    Some(&faces[usize::from(id == SKETCH_UI_DISPLAY_ID)])
}

#[cfg(not(target_os = "macos"))]
fn system_sketch_ui_face(_: &str) -> Option<&'static FontData> { None }
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
    /// Runtime-only host faces for missing Sketch source fonts. Never
    /// serialized and never part of `named`.
    local: LocalFonts,
    /// Resolve `sketchSourceFonts` names against `local`. Native preparation
    /// enables this with local Sketch UI; a WASM host enables it by supplying
    /// bytes through `load_local_fonts`.
    local_source_fonts: bool,
    /// Retained source names by text node id, copied from the document's
    /// Sketch metadata at load time. This is derived state; it is never
    /// written back into the authored node.
    source_names: BTreeMap<String, SketchSourceNames>,
    local_sketch_ui: bool,
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
    local: BTreeMap<String, ([u8; 32], u32)>,
    quantized: bool,
    local_sketch_ui: bool,
    local_source_fonts: bool,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum OutlineOutput {
    None,
    Measurement,
    Geometry,
    Spans,
    Svg,
}
/// Indent of one list level and the gap after its marker, in em of the node
/// font size. Figma's exact list metrics are not measured here.
const LIST_LEVEL_INDENT: f64 = 1.25;
const LIST_MARKER_GAP: f64 = 0.5;
const LIST_BULLETS: [&str; 3] = ["\u{2022}", "\u{25E6}", "\u{25AA}"];

/// A list item's text inset: the level indent, the marker column of its level
/// and the gap. Every line of the paragraph starts there.
#[derive(Clone)]
struct ListItem {
    indent: f64,
    gap: f64,
    marker_width: f64,
    text: String,
}

/// One painted list marker: the byte where its paragraph starts, the marker
/// text and where its first glyph was placed. Tests read it; the glyph table
/// keeps the authored text alone.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ListMarker {
    pub start: usize,
    pub text: String,
    pub x: f64,
    pub y: f64,
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
    /// Preview width adjustment for the bundled Chinese fallback.
    #[serde(skip)]
    pub(crate) width_scale: f64,
    #[serde(skip)]
    pub(crate) height_scale: f64,
    #[serde(skip)]
    pub(crate) ink_offset: Point,
    #[serde(skip)]
    wrap_advance: f64,
    /// Variation coordinates this glyph was shaped with; outlines rebuild the
    /// same face so geometry matches the shaped advances exactly.
    #[serde(skip)]
    vars: Vec<rustybuzz::Variation>,
}

impl Glyph {
    pub(crate) fn has_variations(&self) -> bool {
        !self.vars.is_empty() || self.width_scale != 1. || self.height_scale != 1. || self.ink_offset != Point::default()
    }
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
    #[serde(skip)]
    measurement: Option<TextVerticalMeasurement>,
    #[serde(skip)]
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) list_markers: Vec<ListMarker>,
}

/// Node-local cap line of the first laid-out text line and baseline of the last.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextVerticalMeasurement {
    pub cap_y: Option<f64>,
    pub baseline_y: f64,
}

fn capital_height(face: &ttf_parser::Face<'_>) -> Option<i16> {
    face.capital_height().or_else(|| {
        face.glyph_bounding_box(face.glyph_index('H')?).map(|rect| rect.y_max)
    }).filter(|&height| height > 0)
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
    !id.is_empty() && id.len() <= 128 && !matches!(id, SKETCH_UI_TEXT_ID | SKETCH_UI_DISPLAY_ID)
}
impl TextStyle {
    pub(crate) fn line_height_at(&self, size: f64) -> f64 {
        self.line_height_pixels.unwrap_or(self.line_height * size)
    }

    pub(crate) fn has_fixed_line_height(&self) -> bool {
        !self.line_height_auto && (self.line_height_pixels.is_some()
            || (self.line_height > 0. && (self.line_height - 1.35).abs() > 1e-9))
    }

    pub fn validate(&self) -> Result<(), String> {
        if !["top", "center", "bottom"].contains(&self.vertical_align.as_str())
            || !valid_font_id(&self.font_id)
            || self.fallbacks.len() > 16
            || self.fallbacks.iter().any(|id| !valid_font_id(id))
            || !self.weight.is_finite()
            || !(1. ..=1000.).contains(&self.weight)
            || !self.line_height.is_finite()
            || !(0.1..=10.).contains(&self.line_height)
            || self.line_height_pixels.is_some_and(|height| !(0.1..=40960.).contains(&height))
            || !["", "nearest-point", "sketch-font-leading", "sketch-fixed-advance", "figma-pixel-leading", "figma-font-metrics"]
                .contains(&self.line_box_baseline.as_str())
            || !self.letter_spacing.is_finite()
            || self.letter_spacing.abs() > 1000.
            || !self.paragraph_spacing.is_finite()
            || !(0. ..=10000.).contains(&self.paragraph_spacing)
            || self.list_spacing.is_some_and(|spacing| !(0. ..=10000.).contains(&spacing))
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
            || !valid_list(&self.list, self.list_level, false)
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
                    curve_modes: None,
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
                    video: None,
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
        n.derived_text_paint = true;
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
fn sketch_font_line_box(style: &TextStyle) -> bool {
    // Sketch leaves an unspecified line box on the font's own metrics.
    // The editor default 1.35 stays in force once a line height is authored.
    style.line_height_auto && (style.line_height - 1.35).abs() <= 1e-9
}

fn uses_figma_line_metrics(style: &TextStyle) -> bool {
    style.writing_mode == "horizontal"
        && matches!(style.line_box_baseline.as_str(), "figma-pixel-leading" | "figma-font-metrics")
}

/// Underline top offset and thickness for a Figma line box, in pixels below
/// the snapped ink baseline. OpenType `post.underlinePosition` is the top of
/// the stroke. Figma's derived decoration rect uses the PostScript center
/// (that top minus half the thickness, y-up) as the filled rectangle's top.
/// Poppins Bold 2.000 at 13px in `01有料素材.fig` ("U"): position -125,
/// thickness 50, snapped baseline 14, rect y 15.95, h 0.65.
fn figma_post_underline(face: &ttf_parser::Face<'_>, size: f64) -> Option<(f64, f64)> {
    let metrics = face.underline_metrics()?;
    let units = f64::from(face.units_per_em());
    if units <= 0. || metrics.thickness <= 0 || !size.is_finite() || size <= 0. {
        return None;
    }
    let scale = size / units;
    let thickness = f64::from(metrics.thickness) * scale;
    let top = (f64::from(-metrics.position) + f64::from(metrics.thickness) * 0.5) * scale;
    (thickness.is_finite() && top.is_finite() && thickness > 0. && thickness < 4096.)
        .then_some((top, thickness))
}

fn figma_underline_for(
    fonts: &Fonts,
    glyph: &Glyph,
    cache: &mut Option<(String, u32, u64, f64, f64)>,
) -> Option<(f64, f64)> {
    let weight = glyph.weight.to_bits();
    let size = glyph.size.to_bits();
    if glyph.vars.is_empty() {
        if let Some((id, cached_weight, cached_size, top, thickness)) = cache {
            if id == &glyph.font_id && *cached_weight == weight && *cached_size == size {
                return Some((*top, *thickness));
            }
        }
    }
    let parsed = fonts
        .face_with(&glyph.font_id, glyph.weight, &glyph.vars)
        .ok()?;
    let got = figma_post_underline(parsed.borrow_face(), glyph.size)?;
    if glyph.vars.is_empty() {
        *cache = Some((glyph.font_id.clone(), weight, size, got.0, got.1));
    }
    Some(got)
}

const SKETCH_SYSTEM_TEXT_ASCENT: f64 = 15.46875 / 16.;
const SKETCH_HAN_DISPLAY_ASCENT: f64 = 17.1990966796875 / 20.;

fn sketch_fallback_ascent(character: char, size: f64) -> Option<f64> {
    // Missing faces in Sketch's explicit line boxes use the macOS UI metrics.
    // The simplified Chinese UI fallback switches to its display face at 20 pt.
    // These ascenders were measured with CoreText at 16, 20, 26 and 46 pt.
    if is_sketch_han(character) {
        Some(size * if size < 20. { SKETCH_SYSTEM_TEXT_ASCENT } else { SKETCH_HAN_DISPLAY_ASCENT })
    } else if character.is_ascii_graphic() {
        Some(size * SKETCH_SYSTEM_TEXT_ASCENT)
    } else {
        None
    }
}

fn sketch_han_scale(size: f64) -> (f64, f64) {
    // Match the PingFang UI advance and approximate its glyph height relative
    // to Noto Sans SC. The scales come from CoreText advances and path bounds
    // for ordinary Han at 12–46 pt. Keep the same baseline and wrap decisions.
    if size < 20. {
        (0.9922178988326848, 0.955)
    } else {
        let optical = (size.clamp(20., 46.) - 20.) / 26.;
        (0.9577067669172932 + optical * (0.9445488721804511 - 0.9577067669172932), 0.93)
    }
}

// CoreText's regular UI face uses proportional figures. The old fallback
// gave every digit the same width, which is especially visible in clocks.
// Columns are normalized advance, ink left, ink right, and ink ascent at
// 16 pt (UI text), 20 pt and 26 pt (display optical sizes).
const SKETCH_UI_FIGURES: [[[f64; 4]; 14]; 3] = [
    [
        [0.624, 0.063, 0.565, 0.719],
        [0.444, 0.064, 0.339, 0.705],
        [0.583, 0.068, 0.529, 0.716],
        [0.607, 0.069, 0.563, 0.716],
        [0.624, 0.057, 0.586, 0.705],
        [0.598, 0.069, 0.552, 0.705],
        [0.626, 0.063, 0.565, 0.719],
        [0.550, 0.047, 0.514, 0.705],
        [0.619, 0.063, 0.570, 0.716],
        [0.626, 0.064, 0.566, 0.719],
        [0.277, 0.085, 0.212, 0.500],
        [0.277, 0.058, 0.197, 0.099],
        [0.906, 0.066, 0.859, 0.714],
        [0.277, 0.085, 0.212, 0.122],
    ],
    [
        [0.602, 0.061, 0.564, 0.720],
        [0.437, 0.060, 0.335, 0.705],
        [0.572, 0.068, 0.532, 0.720],
        [0.596, 0.063, 0.558, 0.716],
        [0.612, 0.052, 0.585, 0.705],
        [0.588, 0.070, 0.554, 0.705],
        [0.610, 0.058, 0.571, 0.720],
        [0.542, 0.045, 0.512, 0.705],
        [0.607, 0.059, 0.571, 0.716],
        [0.610, 0.061, 0.574, 0.720],
        [0.255, 0.077, 0.201, 0.496],
        [0.255, 0.049, 0.187, 0.099],
        [0.875, 0.061, 0.837, 0.713],
        [0.255, 0.077, 0.201, 0.118],
    ],
    [
        [0.617, 0.046, 0.562, 0.717],
        [0.454, 0.049, 0.324, 0.705],
        [0.578, 0.054, 0.523, 0.717],
        [0.603, 0.047, 0.542, 0.716],
        [0.616, 0.040, 0.578, 0.705],
        [0.596, 0.059, 0.551, 0.705],
        [0.627, 0.046, 0.563, 0.717],
        [0.557, 0.038, 0.504, 0.705],
        [0.611, 0.045, 0.558, 0.716],
        [0.627, 0.056, 0.573, 0.717],
        [0.231, 0.055, 0.168, 0.484],
        [0.231, 0.024, 0.157, 0.101],
        [0.827, 0.046, 0.773, 0.711],
        [0.231, 0.055, 0.168, 0.106],
    ],
];

// Regular UI face advances at 16, 20 and 26 pt, in 1/2048 em. This keeps
// proportional Latin letters and spaces in the same optical sizes as figures.
const SKETCH_UI_LATIN_ADVANCES: [[u16; 53]; 3] = [
    [
        1340, 1306, 1426, 1448, 1180, 1132, 1489, 1480, 508, 1062, 1309, 1123, 1750,
        1480, 1540, 1261, 1540, 1298, 1265, 1258, 1470, 1340, 1942, 1350, 1302, 1315,
        1090, 1218, 1106, 1218, 1130, 701, 1208, 1165, 466, 465, 1072, 478, 1742,
        1155, 1170, 1210, 1208, 740, 1032, 704, 1155, 1070, 1546, 1034, 1072, 1064, 536,
    ],
    [
        1315, 1274, 1406, 1419, 1153, 1104, 1464, 1453, 481, 1035, 1275, 1096, 1723,
        1453, 1515, 1227, 1515, 1266, 1238, 1226, 1444, 1313, 1915, 1323, 1275, 1287,
        1060, 1183, 1072, 1183, 1095, 667, 1173, 1135, 440, 439, 1038, 448, 1704,
        1122, 1135, 1174, 1173, 699, 998, 668, 1122, 1035, 1511, 1001, 1039, 1023, 493,
    ],
    [
        1325, 1265, 1428, 1416, 1156, 1106, 1471, 1457, 485, 1039, 1258, 1099, 1727,
        1457, 1522, 1211, 1522, 1254, 1240, 1217, 1451, 1317, 1917, 1325, 1279, 1288,
        1054, 1162, 1054, 1162, 1077, 650, 1152, 1130, 447, 445, 1022, 444, 1674,
        1107, 1115, 1153, 1152, 662, 981, 646, 1107, 1017, 1493, 986, 1024, 988, 451,
    ],
];

fn sketch_optical_sizes(size: f64) -> (usize, usize, f64) {
    if size < 20. {
        (0, 1, (size.clamp(16., 20.) - 16.) / 4.)
    } else {
        (1, 2, (size.min(26.) - 20.) / 6.)
    }
}

/// Advance, horizontal scale, vertical scale and horizontal ink displacement.
fn sketch_latin_metrics(character: char, size: f64, weight: f32, face: &ttf_parser::Face<'_>,
    id: ttf_parser::GlyphId) -> Option<(f64, f64, f64, f64)> {
    let index = match character {
        'A'..='Z' => (character as u8 - b'A') as usize,
        'a'..='z' => 26 + (character as u8 - b'a') as usize,
        ' ' => 52,
        _ => return sketch_figure_metrics(character, size, face, id),
    };
    if weight != 400. { return None; }
    let (lower, upper, blend) = sketch_optical_sizes(size);
    let a = f64::from(SKETCH_UI_LATIN_ADVANCES[lower][index]);
    let b = f64::from(SKETCH_UI_LATIN_ADVANCES[upper][index]);
    let advance = (a + blend * (b - a)) / 2048.;
    let natural = f64::from(face.glyph_hor_advance(id)?) / f64::from(face.units_per_em());
    if natural <= 0. { return None; }
    // Match the observed x-height or cap height while keeping the fallback's
    // outline and letting the shaper supply pair positioning.
    let (height, target) = if "acegmnopqrsuvwxyz".contains(character) {
        let optical_x_height = [0.5264, 0.5225, 0.5098];
        (face.x_height(), optical_x_height[lower] + blend * (optical_x_height[upper] - optical_x_height[lower]))
    } else {
        (face.capital_height(), 0.7046)
    };
    let vertical = height.filter(|h| *h > 0).map_or(1., |h| target * f64::from(face.units_per_em()) / f64::from(h));
    Some((advance * size, advance / natural, vertical, 0.))
}

fn sketch_figure_metrics(character: char, size: f64, face: &ttf_parser::Face<'_>,
    id: ttf_parser::GlyphId) -> Option<(f64, f64, f64, f64)> {
    let index = match character {
        '0'..='9' => (character as u8 - b'0') as usize,
        ':' => 10,
        ',' => 11,
        '%' => 12,
        '.' => 13,
        _ => return None,
    };
    let (lower, upper, blend) = sketch_optical_sizes(size);
    let [advance, left, right, ascent] = std::array::from_fn(|i| {
        let a = SKETCH_UI_FIGURES[lower][index][i];
        a + blend * (SKETCH_UI_FIGURES[upper][index][i] - a)
    });
    let bounds = face.glyph_bounding_box(id)?;
    let unit = f64::from(face.units_per_em());
    let min = f64::from(bounds.x_min) / unit;
    let width = (f64::from(bounds.x_max) - f64::from(bounds.x_min)) / unit;
    let top = f64::from(bounds.y_max) / unit;
    if width <= 0. || top <= 0. { return None; }
    let scale = (right - left) / width;
    Some((advance * size, scale, ascent / top, (left - min * scale) * size))
}

fn is_sketch_han(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x323af)
}

fn is_noto_sans_sc(face: &ttf_parser::Face<'_>) -> bool {
    face.names().into_iter().any(|name| {
        name.name_id == ttf_parser::name_id::POST_SCRIPT_NAME
            && name.to_string().is_some_and(|name| name.starts_with("NotoSansSC-"))
    })
}
fn cluster_line_height(runs: &[TextRun], cluster: usize, size: f64, style: &TextStyle) -> f64 {
    run_covering(runs, cluster)
        .and_then(|run| run.line_height)
        .map_or_else(|| style.line_height_at(size), |multiplier| size * multiplier)
}
impl Fonts {
    pub fn new() -> Self {
        Self::default()
    }
    /// Enable locally owned UI glyphs for the native desktop rendering lanes.
    /// Portable, PDF embedding and ordinary authored font resources keep their
    /// existing font book. Missing system faces leave portable fallback active.
    pub fn enable_local_sketch_ui(&mut self) {
        self.local_sketch_ui = cfg!(target_os = "macos");
        self.local_source_fonts = self.local_sketch_ui;
        self.text_paths = Default::default();
    }
    /// Allow installed/host-supplied faces to satisfy `sketchSourceFonts`
    /// names. The document and its portable font table are never modified.
    pub fn enable_local_source_fonts(&mut self) {
        self.local_source_fonts = true;
        self.text_paths = Default::default();
    }
    pub(crate) fn local_source_fonts_enabled(&self) -> bool {
        self.local_source_fonts
    }
    fn local_sketch_ui(&self, id: &str) -> Option<&'static FontData> {
        self.local_sketch_ui.then(|| system_sketch_ui_face(id)).flatten()
    }
    fn shaping_face_data(&self, id: &str) -> Option<&FontData> {
        self.named
            .get(id)
            .or_else(|| self.local.faces.get(id))
            .or_else(|| self.local_sketch_ui(id))
    }
    fn local_face_id(&self, name: &str) -> Option<&str> {
        if !self.local_source_fonts {
            return None;
        }
        self.local
            .names
            .get(&compact_font_name(name))
            .map(String::as_str)
    }
    /// Toggle rendering-side glyph-origin quantisation (see the field
    /// documentation); layout and caret geometry never move.
    pub fn set_glyph_origin_quantization(&mut self, on: bool) {
        self.quantize_glyph_origins = on;
    }
    pub fn glyph_origin_quantization(&self) -> bool {
        self.quantize_glyph_origins
    }
    pub(crate) fn owned_face_bytes(&self, font_id: &str) -> Option<(Arc<Vec<u8>>, u32, [u8; 32])> {
        if font_id.is_empty() || font_id == "default" {
            if self.data.is_empty() {
                return None;
            }
            return Some((Arc::clone(&self.data), 0, self.data_digest));
        }
        let data = self.named.get(font_id)?;
        Some((Arc::clone(&data.bytes), data.index, data.digest))
    }
    pub(crate) fn source_stamp(&self) -> FontSourceStamp {
        FontSourceStamp { default:self.data_digest, quantized:self.quantize_glyph_origins, local_sketch_ui: self.local_sketch_ui,
            local_source_fonts: self.local_source_fonts,
            local:self.local.faces.iter().map(|(id,font)|(id.clone(),(font.digest,font.index))).collect(),
            named:self.named.iter().map(|(id,font)|(id.clone(),(font.digest,font.index))).collect() }
    }
    pub fn load(&mut self, data: &[u8]) -> Result<(), String> {
        check_font(data)?;
        self.data = Arc::new(data.to_vec());
        self.data_digest = Sha256::digest(data).into();
        self.text_paths = Default::default();
        Ok(())
    }
    /// Install one runtime-only host face. The face is addressable only by
    /// source name; it is not a document resource and never appears in
    /// `Document::fonts` or a `.sketch` export.
    pub fn install_local_font(
        &mut self,
        family: &str,
        postscript: Option<&str>,
        data: &[u8],
        index: u32,
    ) -> Result<String, String> {
        if data.len() > MAX_HOST_FONT_BYTES {
            return Err("Host font file exceeds 20 MiB".into());
        }
        self.local_source_fonts = true;
        let face = ttf_parser::Face::parse(data, index)
            .map_err(|_| format!("Font face {index} missing from host font"))?;
        let mut keys = face_name_keys(&face);
        for name in std::iter::once(family).chain(postscript) {
            let key = compact_font_name(name);
            if !key.is_empty() {
                keys.insert(key);
            }
        }
        self.install_local_face(Arc::new(data.to_vec()), index, keys)
    }
    /// Host transport used by the WASM renderer. The payload is a bounded array
    /// of `{family, postscript?, data(base64), index}` entries. Installing any
    /// face enables source-name resolution; without entries the portable
    /// default font remains the terminal fallback.
    pub fn install_local_fonts_json(&mut self, json: &str) -> Result<usize, String> {
        let inputs: Vec<LocalFontInput> =
            serde_json::from_str(json).map_err(|_| "Invalid local font payload")?;
        if inputs.len() > MAX_HOST_FONTS {
            return Err(format!("At most {MAX_HOST_FONTS} host fonts are supported"));
        }
        let mut installed = 0;
        for input in inputs {
            if input.family.trim().is_empty()
                || input.family.chars().count() > 200
                || input.postscript.as_deref().is_some_and(|name| {
                    name.is_empty() || name.chars().count() > 200
                })
            {
                return Err("Invalid host font identity".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(input.data.as_bytes())
                .map_err(|_| "Invalid host font base64")?;
            self.install_local_font(
                &input.family,
                input.postscript.as_deref(),
                &bytes,
                input.index,
            )?;
            installed += 1;
        }
        if installed > 0 {
            self.local_source_fonts = true;
            self.text_paths = Default::default();
        }
        Ok(installed)
    }
    fn install_local_face(
        &mut self,
        bytes: Arc<Vec<u8>>,
        index: u32,
        keys: BTreeSet<String>,
    ) -> Result<String, String> {
        self.local_source_fonts = true;
        let digest: [u8; 32] = Sha256::digest(bytes.as_slice()).into();
        let id = host_font_id(digest, index);
        if self.local.faces.contains_key(&id) {
            for key in keys {
                self.local.names.entry(key).or_insert_with(|| id.clone());
            }
            self.text_paths = Default::default();
            return Ok(id);
        }
        if self.local.faces.len() >= MAX_HOST_FONTS {
            return Err(format!("At most {MAX_HOST_FONTS} host fonts are supported"));
        }
        let total = self.local.total_bytes.checked_add(bytes.len())
            .ok_or_else(|| "Host font budget overflow".to_string())?;
        if total > MAX_HOST_FONT_TOTAL_BYTES {
            return Err("Host fonts exceed their total byte budget".into());
        }
        for key in keys {
            self.local.names.entry(key).or_insert_with(|| id.clone());
        }
        self.local.total_bytes = total;
        self.local.faces.insert(id.clone(), FontData { bytes, digest, index });
        // Paths cached before the face existed must not keep the portable
        // outlines for a now-resolved source name.
        self.text_paths = Default::default();
        Ok(id)
    }
    /// Copy the document's retained Sketch source names into runtime state.
    /// Runs on every target so a WASM host can install bytes before or after
    /// `load_document`; the authored document itself is never modified.
    pub(crate) fn set_sketch_source_names(&mut self, document: &crate::scene::Document) {
        let names = sketch_source_names_by_node(document);
        if names != self.source_names {
            self.source_names = names;
            self.text_paths = Default::default();
        }
    }
    fn retained_source_font_names_all(&self) -> BTreeSet<String> {
        let mut names = BTreeSet::new();
        for source in self.source_names.values() {
            if let Some(name) = &source.style {
                names.insert(name.clone());
            }
            names.extend(source.runs.values().cloned());
            names.extend(source.fallbacks.iter().cloned());
        }
        names
    }
    fn retained_source_font_names(&self) -> BTreeSet<String> {
        let mut names = self.retained_source_font_names_all();
        names.retain(|name| self.local_face_id(name).is_none());
        names
    }
    /// Resolve retained `sketchSourceFonts` names against installed host
    /// faces. Native preparation calls this after document admission; WASM
    /// hosts call `install_local_fonts_json` instead. Unresolved names keep
    /// the existing NotoSansSC terminal fallback.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn resolve_sketch_source_fonts(&mut self) -> usize {
        if !self.local_source_fonts {
            return 0;
        }
        let names = self.retained_source_font_names();
        if names.is_empty() {
            return 0;
        }
        self.install_source_candidates(local_sources::system().candidates(&names))
    }
    /// Bounded transport of the host faces already resolved for this document's
    /// retained Sketch source names. The payload matches `load_local_fonts`
    /// (`{family, postscript?, data(base64), index}`) so a WASM renderer can
    /// install the exact runtime-only faces the native lane used. Only faces
    /// referenced by retained source names are included; the authored document,
    /// its font table and any save/export bytes stay untouched.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn host_font_payload_json(&self) -> String {
        const MAX_PAYLOAD_BYTES: usize = 24 * 1024 * 1024;
        if !self.local_source_fonts {
            return "[]".into();
        }
        let names = self.retained_source_font_names_all();
        if names.is_empty() {
            return "[]".into();
        }
        let mut entries = Vec::new();
        let mut seen = BTreeSet::new();
        let mut total = 0usize;
        for name in &names {
            if entries.len() >= MAX_HOST_FONTS
                || name.is_empty()
                || name.chars().count() > 200
            {
                continue;
            }
            let Some(id) = self.local_face_id(name).map(str::to_owned) else {
                continue;
            };
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(face) = self.local.faces.get(&id) else {
                continue;
            };
            if total + face.bytes.len() > MAX_PAYLOAD_BYTES {
                continue;
            }
            let Ok(parsed) = ttf_parser::Face::parse(&face.bytes, face.index) else {
                continue;
            };
            let family = face_name_value(
                &parsed,
                &[
                    ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
                    ttf_parser::name_id::FAMILY,
                ],
            )
            .unwrap_or_else(|| name.clone());
            let postscript = face_name_value(&parsed, &[ttf_parser::name_id::POST_SCRIPT_NAME]);
            let mut entry = serde_json::Map::new();
            entry.insert("family".into(), serde_json::json!(family));
            if let Some(postscript) = postscript {
                entry.insert("postscript".into(), serde_json::json!(postscript));
            }
            entry.insert(
                "data".into(),
                serde_json::json!(base64::engine::general_purpose::STANDARD.encode(face.bytes.as_slice())),
            );
            entry.insert("index".into(), serde_json::json!(face.index));
            total += face.bytes.len();
            entries.push(serde_json::Value::Object(entry));
        }
        serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into())
    }
    /// Same document-level resolution against explicit roots, for tests and
    /// hosts that stage a font directory themselves.
    #[cfg(not(target_arch = "wasm32"))]
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn resolve_sketch_source_fonts_from_dirs(
        &mut self,
        dirs: &[std::path::PathBuf],
    ) -> usize {
        if !self.local_source_fonts {
            return 0;
        }
        let names = self.retained_source_font_names();
        if names.is_empty() {
            return 0;
        }
        self.install_source_fonts_from_dirs(dirs, &names)
    }
    /// Trusted host/test entry point with explicit roots. The RPC surface never
    /// accepts directories; production uses the fixed platform roots above.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn install_source_fonts_from_dirs(
        &mut self,
        dirs: &[std::path::PathBuf],
        names: &BTreeSet<String>,
    ) -> usize {
        let index = local_sources::index(dirs);
        self.install_source_candidates(index.candidates(names))
    }
    #[cfg(not(target_arch = "wasm32"))]
    fn install_source_candidates(
        &mut self,
        candidates: Vec<(String, std::path::PathBuf)>,
    ) -> usize {
        const READ_BUDGET: usize = 64 * 1024 * 1024;
        let mut installed = 0;
        let mut read_bytes = 0usize;
        let mut files: HashMap<std::path::PathBuf, Arc<Vec<u8>>> = HashMap::new();
        for (name, path) in candidates {
            if self.local_face_id(&name).is_some() {
                continue;
            }
            if self.local.faces.len() >= MAX_HOST_FONTS || read_bytes >= READ_BUDGET {
                break;
            }
            let data = if let Some(data) = files.get(&path) {
                Arc::clone(data)
            } else {
                let Ok(metadata) = std::fs::metadata(&path) else { continue };
                if !metadata.is_file() || metadata.len() > MAX_HOST_FONT_BYTES as u64 {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&path) else { continue };
                if bytes.len() > MAX_HOST_FONT_BYTES || read_bytes + bytes.len() > READ_BUDGET {
                    continue;
                }
                read_bytes += bytes.len();
                let data = Arc::new(bytes);
                files.insert(path.clone(), Arc::clone(&data));
                data
            };
            let wanted = compact_font_name(&name);
            let faces = ttf_parser::fonts_in_collection(&data).unwrap_or(1).min(256);
            let mut found: Option<(u8, u32, BTreeSet<String>)> = None;
            for index in 0..faces {
                let Ok(face) = ttf_parser::Face::parse(&data, index) else {
                    continue;
                };
                let Some(rank) = source_face_rank(&face, &wanted) else {
                    continue;
                };
                if found.as_ref().is_none_or(|(best, _, _)| rank < *best) {
                    found = Some((rank, index, face_name_keys(&face)));
                }
            }
            if let Some((_, index, keys)) = found
                && self.install_local_face(data, index, keys).is_ok()
            {
                installed += 1;
            }
        }
        installed
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
            local: self.local.clone(),
            local_source_fonts: self.local_source_fonts,
            source_names: self.source_names.clone(),
            local_sketch_ui: self.local_sketch_ui,
            quantize_glyph_origins: self.quantize_glyph_origins,
        };
        let mut total = 0;
        for (id, resource) in resources {
            if id == "default"
                || id.starts_with('\0')
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
        } else if let Some(font) = self.local.faces.get(id) {
            Ok(font.bytes.as_slice())
        } else {
            self.named
                .get(id)
                .map(|f| f.bytes.as_slice())
                .ok_or_else(|| format!("Missing font resource: {id}"))
        }
    }
    /// Portable text view: host-only source faces stay out of PDF font
    /// embedding, so a host font never becomes an embedded commercial font in
    /// an exported PDF. The raster/SVG paths keep the resolved outlines.
    pub(crate) fn portable_text(&self) -> Self {
        if !self.local_source_fonts {
            return self.clone();
        }
        let mut portable = self.clone();
        portable.local_source_fonts = false;
        portable
    }
    fn face(&self, id: &str, weight: f32) -> Result<Arc<ParsedFontFace>, String> {
        self.face_with(id, weight, &[])
    }
    fn face_index(&self, id: &str) -> u32 {
        if id == "default" {
            0
        } else {
            self.shaping_face_data(id).map_or(0, |f| f.index)
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
            let font = self.shaping_face_data(id)
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
    fn glyph_outline(&self, glyph: &Glyph) -> Result<Arc<crate::font_glyph_cache::Outline>, String> {
        self.outline_for_id(&glyph.font_id, glyph.id, glyph.weight, &glyph.vars)
    }
    fn outline_for_id(&self, font_id: &str, glyph: u16, weight: f32, axes: &[rustybuzz::Variation])
        -> Result<Arc<crate::font_glyph_cache::Outline>, String> {
        use crate::font_glyph_cache::{Key, Outline};
        let digest = if font_id == "default" {
            self.data_digest
        } else {
            self.shaping_face_data(font_id)
                .ok_or_else(|| format!("Missing font resource: {font_id}"))?
                .digest
        };
        let key = Key {
            font: digest,
            face: self.face_index(font_id),
            glyph,
            weight: weight.to_bits(),
            axes: axes
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
        let face = self.face_with(font_id, weight, axes)?;
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
            italic_face: face.is_italic() || face.is_oblique(),
            ..Outline::default()
        };
        #[cfg(target_os = "macos")]
        if matches!(font_id, SKETCH_UI_TEXT_ID | SKETCH_UI_DISPLAY_ID) {
            let (commands, advance) = macos_outlines::outline(font_id == SKETCH_UI_DISPLAY_ID, glyph, face.units_per_em())
                .ok_or_else(|| "Local CoreText outline unavailable".to_string())?;
            outline.commands = commands;
            outline.local_advance = Some(advance);
        } else {
            face.outline_glyph(ttf_parser::GlyphId(glyph), &mut outline);
        }
        #[cfg(not(target_os = "macos"))]
        face.outline_glyph(ttf_parser::GlyphId(glyph), &mut outline);
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
                false,
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
            false,
        )?;
        Ok((l.width.max(0.01), l.height))
    }
    pub fn node_layout(&self, node: &Node, width: Option<f64>) -> Result<TextLayout, String> {
        self.node_outline_layout(node, width, OutlineOutput::Svg)
    }
    pub fn node_text_measurement(&self, node: &Node) -> Result<Option<TextVerticalMeasurement>, String> {
        if node.kind != "text" || node.text_path.is_some()
            || node.text_style.as_ref().is_some_and(|style| style.writing_mode == "vertical")
        {
            return Ok(None);
        }
        Ok(self.node_outline_layout(node, Some(node.width), OutlineOutput::Measurement)?.measurement)
    }
    fn local_source_style(
        &self,
        node: &Node,
        style: &TextStyle,
        runs: &[TextRun],
    ) -> Option<(TextStyle, Vec<TextRun>)> {
        if !self.local_source_fonts || self.local.faces.is_empty() {
            return None;
        }
        let source = self
            .source_names
            .get(&node.id)
            .cloned()
            .or_else(|| SketchSourceNames::from_node(node))?;
        let mut styled = style.clone();
        let mut changed = false;
        if style.font_id == "default"
            && let Some(id) = source
                .style
                .as_deref()
                .and_then(|name| self.local_face_id(name))
        {
            styled.font_id = id.to_owned();
            changed = true;
        }
        for name in &source.fallbacks {
            if styled.fallbacks.len() >= 16 {
                break;
            }
            if let Some(id) = self.local_face_id(name)
                && !styled.fallbacks.iter().any(|font| font == id)
            {
                styled.fallbacks.push(id.to_owned());
                changed = true;
            }
        }
        let mut resolved_runs = None;
        for (index, name) in &source.runs {
            let Ok(index) = index.parse::<usize>() else {
                continue;
            };
            let Some(run) = runs.get(index) else {
                continue;
            };
            if run.font_id.as_deref().unwrap_or("default") != "default" {
                continue;
            }
            let Some(id) = self.local_face_id(name) else {
                continue;
            };
            let runs = resolved_runs.get_or_insert_with(|| runs.to_vec());
            runs[index].font_id = Some(id.to_owned());
            changed = true;
        }
        changed.then(|| (styled, resolved_runs.unwrap_or_else(|| runs.to_vec())))
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
        let resolved = self.local_source_style(node, style, &node.text_runs);
        let (style, runs) = match &resolved {
            Some((style, runs)) => (style, runs.as_slice()),
            None => (style, node.text_runs.as_slice()),
        };
        let mut result = self.layout(
            &node.text,
            node.font_size,
            style,
            runs,
            width,
            output,
            node.text_path.as_deref(),
            sketch_font_line_box(style),
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
                if let Some(measurement) = &mut result.measurement {
                    measurement.cap_y = measurement.cap_y.map(|y| y + offset);
                    measurement.baseline_y += offset;
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
        let resolved = self.local_source_style(node, style, &node.text_runs);
        let (style, runs) = match &resolved {
            Some((style, runs)) => (style, runs.as_slice()),
            None => (style, node.text_runs.as_slice()),
        };
        self.layout(
            &node.text,
            node.font_size,
            style,
            runs,
            width,
            OutlineOutput::None,
            node.text_path.as_deref(),
            sketch_font_line_box(style),
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
            self.local_source_fonts,
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
        sketch_display_fallback: bool,
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
        let mut small_caps_features = None;
        let mut forced_caps_features = None;
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
        // FIG's measured horizontal advances use a 1/1024 em grid before
        // tracking. Retain that metric for the imported FIG line-box modes.
        let figma_advances = uses_figma_line_metrics(style);
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
                let mut chain: Vec<&str> = Vec::with_capacity(style.fallbacks.len() + 2 + usize::from(self.local_sketch_ui));
                if self.local_sketch_ui && sketch_display_fallback && matches!(font_id, "" | "default") &&
                    style.fallbacks.is_empty() && features.is_empty() && variations.is_empty() &&
                    weight == 400. && cluster.chars().all(is_sketch_han) {
                    let id = if size < 20. { SKETCH_UI_TEXT_ID } else { SKETCH_UI_DISPLAY_ID };
                    // Admission includes the outline, not just cmap coverage.
                    // Apple UI faces can expose metrics without portable
                    // outlines; in that case leave the bundled path in place.
                    if self.face(id, weight).ok().is_some_and(|face| cluster.chars().all(|ch|
                        face.borrow_face().glyph_index(ch).is_some_and(|glyph|
                            self.outline_for_id(id, glyph.0, weight, &[]).is_ok()))) {
                        chain.push(id);
                    }
                }
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
                let case = run_covering(runs, utf16[base + start])
                    .and_then(|run| run.text_case)
                    .unwrap_or(style.text_case);
                let features: &[rustybuzz::Feature] = match case {
                    TextCase::SmallCaps => small_caps_features.get_or_insert_with(|| {
                        let mut features = features.clone();
                        features.push(rustybuzz::Feature::from_str("smcp").unwrap());
                        features
                    }),
                    TextCase::SmallCapsForced => forced_caps_features.get_or_insert_with(|| {
                        let mut features = features.clone();
                        features.push(rustybuzz::Feature::from_str("smcp").unwrap());
                        features.push(rustybuzz::Feature::from_str("c2sc").unwrap());
                        features
                    }),
                    _ => &features,
                };
                let face = self.face_with(&id, weight, &variations)?;
                let em = f64::from(face.borrow_face().units_per_em());
                let scale = size / em;
                let mut buffer = rustybuzz::UnicodeBuffer::new();
                buffer.push_str(&text[start..end]);
                buffer.guess_segment_properties();
                buffer.set_direction(if rtl {
                    rustybuzz::Direction::RightToLeft
                } else {
                    rustybuzz::Direction::LeftToRight
                });
                let split_figma_advance = figma_advances && buffer.script() == rustybuzz::script::LATIN
                    && face.borrow_face().is_variable();
                let figma_grid = |value: f64| (value * 1024. / em).round_ties_even();
                let shaped = self.shape_run(&face, &text[start..end], features, buffer)?;
                for (index, (glyph, p)) in shaped.infos.iter().zip(&shaped.positions).enumerate() {
                    let last_in_cluster = shaped
                        .infos
                        .get(index + 1)
                        .is_none_or(|next| next.cluster != glyph.cluster);
                    let byte = start + glyph.cluster as usize;
                    let cluster = utf16[base + byte];
                    let advance = f64::from(p.x_advance).abs();
                    let mut raw_advance = if figma_advances {
                        // Figma's Latin variable-font layout rounds the nominal
                        // advance and the positioning adjustment individually.
                        let grid_advance = if split_figma_advance
                            && let Some(nominal) = face.borrow_face().glyph_hor_advance(ttf_parser::GlyphId(glyph.glyph_id as u16))
                        {
                            let nominal = f64::from(nominal);
                            figma_grid(nominal) + figma_grid(advance - nominal)
                        } else {
                            figma_grid(advance)
                        };
                        grid_advance * (size / 1024.)
                    } else {
                        advance * scale
                    };
                    if self.local_sketch_ui && matches!(id.as_str(), SKETCH_UI_TEXT_ID | SKETCH_UI_DISPLAY_ID) {
                        if let Some(advance) = self.outline_for_id(&id, glyph.glyph_id as u16, weight, &variations)?.local_advance {
                            raw_advance = advance * scale;
                        }
                    }
                    let (width_scale, height_scale, ink_offset, advance) = if sketch_display_fallback && id == "default" {
                        let character = text[byte..].chars().next().unwrap_or_default();
                        if is_sketch_han(character) {
                            let (width, height) = sketch_han_scale(size);
                            // Native PNGs put the fallback ink below the SVG
                            // baseline. Fixed display-size line boxes add more
                            // space above the ink. Keep the caret and line box.
                            let drop = if size >= 20. && style.line_box_baseline == "sketch-fixed-advance" {
                                0.064
                            } else {
                                0.019
                            };
                            (width, height, Point::new(0., size * drop), raw_advance * width)
                        } else if p.x_advance > 0
                            && style.features.is_empty() && variations.is_empty()
                            && face.borrow_face().glyph_index(character) == Some(ttf_parser::GlyphId(glyph.glyph_id as u16))
                            && let Some((target, width, height, left)) = sketch_latin_metrics(character, size, weight, face.borrow_face(), ttf_parser::GlyphId(glyph.glyph_id as u16))
                        {
                            // Keep any pair positioning from the shaper. Only
                            // replace the advance of the unpositioned glyph.
                            let natural = face.borrow_face().glyph_hor_advance(ttf_parser::GlyphId(glyph.glyph_id as u16))
                                .map(|units| f64::from(units) * scale).unwrap_or(raw_advance);
                            (width, height, Point::new(left, 0.), (target + raw_advance - natural).max(0.))
                        } else {
                            (1., 1., Point::default(), raw_advance)
                        }
                    } else {
                        (1., 1., Point::default(), raw_advance)
                    };
                    let tracking = if last_in_cluster { cluster_tracking(runs, cluster, style) } else { 0. };
                    raw_advance += tracking;
                    glyphs.push(Glyph {
                        path_transform: None,
                        id: glyph.glyph_id as u16,
                        font_id: id.clone(),
                        size,
                        weight,
                        cluster,
                        cluster_end: 0,
                        x: p.x_offset as f64 * scale * width_scale,
                        y: -p.y_offset as f64 * scale,
                        advance: advance + tracking,
                        byte: base + byte,
                        width_scale,
                        height_scale,
                        ink_offset,
                        wrap_advance: raw_advance,
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
        font_line_box: bool,
    ) -> Result<TextLayout, String> {
        if style.text_case == TextCase::Original
            && runs
                .iter()
                .all(|r| r.text_case.is_none_or(|c| c == TextCase::Original))
        {
            return self.layout_raw(
                text,
                size,
                style,
                runs,
                width,
                output,
                text_path,
                font_line_box,
            );
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
            font_line_box,
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
        font_line_box: bool,
    ) -> Result<TextLayout, String> {
        style.validate()?;
        if !size.is_finite() || size <= 0. || size > 4096. || text.len() > 400000 {
            return Err("Invalid text layout inputs".into());
        }
        let baseline = text_path.map(crate::text_path::Baseline::new).transpose()?;
        let snap_figma_ink = uses_figma_line_metrics(style) && style.vertical_align == "top" && baseline.is_none();
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
        let mut previous_figma_line = None;
        let mut measurement: Option<TextVerticalMeasurement> = None;
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
        let paragraph_at = |start: usize| run_covering(runs, utf16[start]).and_then(|run| run.paragraph.as_ref());
        let first_line_height = paragraph_at(paragraphs[0].start).and_then(TextParagraph::fixed_line_height);
        let uniform_sketch_line_height = style.line_box_baseline == "sketch-fixed-advance"
            && first_line_height.is_some()
            && paragraphs.iter().all(|p| {
                paragraph_at(p.start).and_then(TextParagraph::fixed_line_height) == first_line_height
            });
        let sketch_spacing = uniform_sketch_line_height || style.line_box_baseline == "sketch-font-leading";
        let use_builtin_text_metrics = sketch_spacing && self.face("default", 400.).ok().is_some_and(|face| {
            is_noto_sans_sc(face.borrow_face())
        });
        let sketch_display_fallback = use_builtin_text_metrics && style.writing_mode == "horizontal";
        // A paragraph is a list item when its own or the layer's list style says
        // so. Its marker is shaped like text and painted in a gutter before the
        // first line; every line of the item starts after that gutter, so a
        // wrapped line stays aligned with the first one. Markers join the
        // painted outline only: the glyph table that caret and selection
        // geometry read keeps the authored text alone.
        let paragraph_count = paragraphs.len();
        let mut list_items = Vec::<Option<ListItem>>::new();
        let mut list_glyphs = Vec::<Vec<Glyph>>::new();
        let mut list_marker_glyphs = Vec::<Glyph>::new();
        let mut list_markers = Vec::<ListMarker>::new();
        let is_list = |kind: &str| matches!(kind, "bullet" | "ordered");
        let list_layout = style.writing_mode == "horizontal"
            && baseline.is_none()
            && style.direction != "rtl"
            && (is_list(&style.list)
                || runs.iter().any(|run| {
                    run.paragraph.as_ref().is_some_and(|paragraph| is_list(&paragraph.list))
                }));
        if list_layout {
            list_items.resize_with(paragraph_count, || None);
            list_glyphs.resize_with(paragraph_count, Vec::new);
            // Numbering continues through consecutive ordered items of one
            // level. A bullet or a paragraph outside a list restarts every level.
            let mut ordinals = [0usize; 5];
            let mut prepared = Vec::<Option<(usize, String)>>::with_capacity(paragraph_count);
            for paragraph in &paragraphs {
                let attributes = paragraph_at(paragraph.start);
                // An empty paragraph list inherits the layer's list style.
                let own = attributes.map(|p| p.list.as_str()).unwrap_or("");
                let kind = if own.is_empty() { style.list.as_str() } else { own };
                if !is_list(kind) {
                    ordinals = [0; 5];
                    prepared.push(None);
                    continue;
                }
                let level = attributes.and_then(|p| p.list_level).or(style.list_level).unwrap_or(0).min(4) as usize;
                for deeper in ordinals.iter_mut().skip(level + 1) {
                    *deeper = 0;
                }
                let marker = if kind == "bullet" {
                    ordinals = [0; 5];
                    LIST_BULLETS[level % LIST_BULLETS.len()].to_string()
                } else {
                    ordinals[level] += 1;
                    format!("{}.", ordinals[level])
                };
                prepared.push(Some((level, marker)));
            }
            // The marker takes the style of the item's first character.
            let mut columns = [0f64; 5];
            let mut widths = vec![0f64; paragraph_count];
            let mut texts = vec![String::new(); paragraph_count];
            for (index, (paragraph, item)) in paragraphs.iter().zip(&prepared).enumerate() {
                let Some((level, marker)) = item else { continue };
                texts[index] = marker.clone();
                let first = utf16[paragraph.start];
                let mut utf16_marker = vec![0; marker.len() + 1];
                let mut position = 0;
                for (byte, c) in marker.char_indices() {
                    utf16_marker[byte] = position;
                    position += c.len_utf16();
                }
                utf16_marker[marker.len()] = position;
                let marker_run = run_covering(runs, first).map(|run| {
                    let mut run = run.clone();
                    run.paragraph = None;
                    run.text_case = None;
                    run.start = 0;
                    run.end = position;
                    run
                });
                let marker_runs: &[TextRun] = match &marker_run {
                    Some(run) => std::slice::from_ref(run),
                    None => &[],
                };
                let mut glyphs = self.shape(marker, 0, size, style, marker_runs, &utf16_marker, sketch_display_fallback)?;
                // Run and metric lookups answer for the item's first character.
                for glyph in &mut glyphs {
                    glyph.cluster = paragraph.start;
                    glyph.cluster_end = paragraph.end;
                    glyph.byte = paragraph.start;
                }
                let width = glyphs.iter().map(|glyph| glyph.advance).sum::<f64>();
                columns[*level] = columns[*level].max(width);
                widths[index] = width;
                list_glyphs[index] = glyphs;
            }
            // Numbers of one level share a column, so "9." and "10." end alike.
            for (index, item) in list_items.iter_mut().enumerate() {
                if let Some((level, _)) = &prepared[index] {
                    *item = Some(ListItem {
                        indent: LIST_LEVEL_INDENT * *level as f64 * size + columns[*level] + LIST_MARKER_GAP * size,
                        gap: LIST_MARKER_GAP * size,
                        marker_width: widths[index],
                        text: texts[index].clone(),
                    });
                }
            }
        }
        let nearest_point = style.line_box_baseline == "nearest-point"
            || (style.line_box_baseline == "sketch-fixed-advance" && !uniform_sketch_line_height);
        let sketch_baseline = if paragraphs.len() > 1 && nearest_point && style.writing_mode != "vertical" {
            let mut heights = paragraphs.iter().map_while(|range| paragraph_at(range.start)?.fixed_line_height());
            heights.next().and_then(|first| {
                let (count, minimum) = heights.fold((1, first), |(count, min), h| (count + 1, min.min(h)));
                if count < 2 { return None; }
                let last = utf16[paragraphs[count - 1].end];
                let cap_height = |font: &str, weight, size| {
                    let parsed = self.face(font, weight).ok()?;
                    let face = parsed.borrow_face();
                    let cap = capital_height(face)?;
                    Some(f64::from(cap) * size / f64::from(face.units_per_em()))
                };
                let mut cap = cap_height(&style.font_id, style.weight, size)?;
                for run in runs.iter().take_while(|run| run.start < last) {
                    cap = cap.max(cap_height(run.font_id.as_deref().unwrap_or(&style.font_id),
                        run.weight.unwrap_or(style.weight), run.font_size.unwrap_or(size))?);
                }
                // Sketch anchors consecutive fixed line boxes to one baseline.
                // The smallest box and largest cap in that range determine the
                // whole-point space below the cap; advances keep their own
                // line heights and paragraph gaps, including blank paragraphs.
                let below_cap = ((minimum - cap) / 2.).floor().max(0.);
                Some((count, first - below_cap))
            })
        } else { None };
        for (paragraph_index, paragraph) in paragraphs.into_iter().enumerate() {
            let attributes = paragraph_at(paragraph.start);
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
            let list_item = list_items.get(paragraph_index).and_then(Option::as_ref);
            let list_indent = list_item.map_or(0., |item| item.indent);
            let value = &text[paragraph.clone()];
            let initial = self.shape(value, paragraph.start, size, style, runs, &utf16, sketch_display_fallback)?;
            // A fallback preview may be narrower while keeping the authored
            // wrap decisions. Fit against the advances of the unscaled face.
            let mut clusters = BTreeMap::<usize, f64>::new();
            for glyph in &initial {
                *clusters.entry(glyph.byte).or_default() += glyph.wrap_advance;
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
                        // A space that itself overflows hangs on this line.
                        // Breaking there rewinds to the previous legal break
                        // and drops the word that already fit, which is how a
                        // Sketch title that is three lines becomes four or five.
                        let byte = entries[end].0;
                        let hanging = text[byte..]
                            .chars()
                            .next()
                            .is_some_and(|ch| matches!(ch, ' ' | '\t'));
                        let tracking = cluster_tracking(runs, utf16[byte], style);
                        if end > begin
                            && !hanging
                            && advance + entries[end].1 - tracking
                                + list_indent
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
                    self.shape(&text[range.clone()], range.start, size, style, runs, &utf16, sketch_display_fallback)?
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
                let figma_auto = style.line_height_auto && style.line_box_baseline == "figma-font-metrics";
                // An empty list item has no text to give its line a font
                // metric, so its marker stands in for the text of the item.
                let metrics: &[Glyph] = if list_item.is_some() && shaped.is_empty() && range.start == paragraph.start {
                    &list_glyphs[paragraph_index]
                } else {
                    &shaped
                };
                let mut ascent = if figma_auto || metrics.is_empty() || attributes.is_some() {
                    0.
                } else {
                    // Seed the line box with the style font's ascent floor; a
                    // resource that vanished from the document degrades to the
                    // fonts the line actually shaped onto.
                    let face = self
                        .face(&style.font_id, style.weight)
                        .or_else(|_| self.face(&metrics[0].font_id, metrics[0].weight))?;
                    let face = face.borrow_face();
                    face.ascender() as f64 * size / face.units_per_em() as f64
                };
                let explicit_line_height = metrics.iter().any(|glyph| {
                    run_covering(runs, glyph.cluster).is_some_and(|run| run.line_height.is_some())
                });
                // Without a run override the node font size remains the line-box
                // floor, including when every glyph is smaller than that size.
                let mut height = if explicit_line_height {
                    0.
                } else {
                    style.line_height_at(size)
                };
                let mut natural = 0f64;
                // Figma centers the ascent and descent inside an explicit
                // line box. Its Auto line advance also includes the font gap.
                let explicit_figma_box = style.line_box_baseline == "figma-pixel-leading"
                    && attributes.is_none() && !font_line_box;
                let use_sketch_ascender = (style.line_box_baseline == "sketch-font-leading"
                    || uniform_sketch_line_height)
                    && attributes.and_then(TextParagraph::fixed_line_height).is_some();
                let use_sketch_leading = style.line_box_baseline == "sketch-font-leading"
                    && use_sketch_ascender;
                let mut leading = 0f64;
                for glyph in metrics {
                    let face = self.face(&glyph.font_id, glyph.weight)?;
                    let face = face.borrow_face();
                    if use_sketch_leading {
                        leading = leading.max(f64::from(face.line_gap()) * glyph.size / f64::from(face.units_per_em()));
                    }
                    let natural_ascent = f64::from(face.ascender()) * glyph.size / f64::from(face.units_per_em());
                    let character = text[glyph.byte..].chars().next();
                    let fallback_ascent = if use_sketch_ascender && sketch_display_fallback && matches!(glyph.font_id.as_str(), "default" | SKETCH_UI_TEXT_ID | SKETCH_UI_DISPLAY_ID) {
                        character.and_then(|ch| {
                            if ch.is_ascii_whitespace() { Some(0.) }
                            else { sketch_fallback_ascent(ch, glyph.size) }
                        })
                    } else { None };
                    ascent = ascent.max(fallback_ascent.unwrap_or(natural_ascent));
                    let glyph_height = if explicit_line_height {
                        cluster_line_height(runs, glyph.cluster, glyph.size, style)
                    } else {
                        style.line_height_at(glyph.size)
                    };
                    height = height.max(glyph_height);
                    let font_gap = if explicit_figma_box { 0. } else { f64::from(face.line_gap()) };
                    natural = natural.max(
                        (f64::from(face.ascender()) - f64::from(face.descender()) + font_gap)
                            * glyph.size
                            / f64::from(face.units_per_em()),
                    );
                }
                if let Some(p) = attributes {
                    if ascent == 0. && use_sketch_ascender && sketch_display_fallback {
                        ascent = size * SKETCH_SYSTEM_TEXT_ASCENT;
                    }
                    if shaped.is_empty() {
                        let face = self.face(&style.font_id, style.weight)?;
                        let face = face.borrow_face();
                        natural = (face.ascender() as f64 - face.descender() as f64
                            + face.line_gap() as f64)
                            * size
                            / face.units_per_em() as f64;
                        ascent = if use_sketch_ascender && sketch_display_fallback && style.font_id == "default" {
                            // An empty line inherits the primary UI line metric.
                            size * SKETCH_SYSTEM_TEXT_ASCENT
                        } else {
                            f64::from(face.ascender()) * size / f64::from(face.units_per_em())
                        };
                        if use_sketch_leading {
                            leading = (f64::from(face.line_gap()) * size / f64::from(face.units_per_em())).max(0.);
                        }
                    }
                    height = natural.max(p.minimum_line_height);
                    if p.maximum_line_height > 0. {
                        height = height.min(p.maximum_line_height);
                    }
                    // Center the font metrics in the constrained line box.
                    // Authored paragraphs stay unrounded. A Sketch fixed line box
                    // (equal minimum and maximum) uses the nearest document point,
                    // which is where native text-preview matrices draw the baseline.
                    if use_sketch_ascender {
                        // Sketch leaves the first baseline on the ascender
                        // as the custom line height changes. Old spacing
                        // modes additionally include the font's leading.
                        ascent = ascent.round_ties_even();
                        height += leading;
                    } else {
                        ascent += (height - natural) / 2.;
                        if let Some((_, baseline)) = sketch_baseline.filter(|(count, _)| paragraph_index < *count) {
                            ascent = baseline;
                        } else if nearest_point && (p.fixed_line_height().is_some() || sketch_baseline.is_some()) {
                            ascent = ascent.round_ties_even();
                        }
                    }
                } else if style.line_box_baseline == "figma-pixel-leading" && natural > 0. {
                    ascent += (height - natural) / 2.;
                }
                if (font_line_box || figma_auto) && attributes.is_none() && !explicit_line_height {
                    if natural == 0. {
                        if let Ok(face) = self.face(&style.font_id, style.weight) {
                            let face = face.borrow_face();
                            let scale = size / face.units_per_em() as f64;
                            natural = (face.ascender() as f64 - face.descender() as f64
                                + face.line_gap() as f64)
                                * scale;
                            if shaped.is_empty() {
                                ascent = face.ascender() as f64 * scale;
                            }
                        }
                    }
                    if natural > 0. {
                        if figma_auto {
                            let rounded = natural.round();
                            height = if rounded > 0. { rounded } else { natural };
                            ascent += (height - natural) / 2.;
                        } else {
                            // Sketch snaps the ascender and the next line's
                            // advance independently to whole document points.
                            ascent = ascent.round_ties_even();
                            let rounded = natural.round_ties_even();
                            height = if rounded > 0. { rounded } else { natural };
                        }
                    }
                }
                if style.line_box_baseline == "figma-pixel-leading" && attributes.is_none()
                    && explicit_line_height && natural > 0.
                {
                    // With a common font metric, Figma advances to the next
                    // baseline using that line's authored height. Align the
                    // adjacent box edges by half the change in explicit leading.
                    if let Some((previous_height, previous_natural)) = previous_figma_line {
                        if previous_natural == natural {
                            y += (height - previous_height) / 2.;
                        }
                    }
                    previous_figma_line = Some((height, natural));
                } else {
                    previous_figma_line = None;
                }
                let trailing = shaped
                    .last()
                    .map(|glyph| cluster_tracking(runs, glyph.cluster, style))
                    .unwrap_or(0.);
                let line_width = (shaped.iter().map(|g| g.advance).sum::<f64>() - trailing).max(0.);
                let baseline_y = y + ascent;
                // Figma snaps the ink baseline in text-local points. Keep
                // fractional layout, diacritic offsets and line advances.
                let ink_y = if snap_figma_ink && attributes.is_none() {
                    baseline_y.round() - baseline_y
                } else {
                    0.
                };
                if let (true, Some(item)) = (range.start == paragraph.start, list_item) {
                    // The marker ends one gap before the text of its first line.
                    let marker_x = list_indent - item.gap - item.marker_width;
                    let mut pen = marker_x;
                    for mut glyph in std::mem::take(&mut list_glyphs[paragraph_index]) {
                        glyph.x += pen;
                        glyph.y += baseline_y;
                        glyph.ink_offset.y += ink_y;
                        pen += glyph.advance;
                        list_marker_glyphs.push(glyph);
                    }
                    list_markers.push(ListMarker {
                        start: paragraph.start,
                        text: item.text.clone(),
                        x: marker_x,
                        y: baseline_y,
                    });
                }
                if output == OutlineOutput::Measurement && !shaped.is_empty() {
                    if let Some(measurement) = &mut measurement {
                        measurement.baseline_y = baseline_y;
                    } else {
                        let mut previous: Option<&Glyph> = None;
                        let cap = shaped.iter().filter_map(|glyph| {
                            let duplicate = previous.replace(glyph).is_some_and(|prev|
                                prev.font_id == glyph.font_id && prev.weight == glyph.weight
                                    && prev.size == glyph.size && prev.vars == glyph.vars);
                            if duplicate { return None; }
                            let face = self.face_with(&glyph.font_id, glyph.weight, &glyph.vars).ok()?;
                            let face = face.borrow_face();
                            Some(f64::from(capital_height(face)?) * glyph.size / f64::from(face.units_per_em()))
                        }).reduce(f64::max);
                        measurement = Some(TextVerticalMeasurement {
                            cap_y: cap.map(|height| baseline_y - height),
                            baseline_y,
                        });
                    }
                }
                let available = width.map(|w| (w - list_indent).max(0.)).unwrap_or(line_width);
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
                // A list item keeps every line after its marker gutter.
                x += list_indent;
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
                    glyph.y += baseline_y;
                    glyph.ink_offset.y += ink_y;
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
                widest = widest.max(line_width + inset + list_indent);
                y += height;
                glyphs.extend(shaped);
                if glyphs.len() > 200000 || lines.len() > 100000 {
                    return Err("Text layout work budget exceeded".into());
                }
            }
            let figma_soft_break = attributes.is_none() && uses_figma_line_metrics(style)
                && text[paragraph.end..].starts_with('\u{2028}');
            if paragraph.end < text.len() && !figma_soft_break {
                if limit.is_some() && style.writing_mode == "vertical" {
                    // Vertical block flow runs horizontally: paragraph gaps
                    // open between columns.
                    column_x += style.paragraph_spacing;
                } else {
                    y += style.paragraph_spacing;
                    if list_item.is_some() && list_items.get(paragraph_index + 1).is_some_and(Option::is_some) {
                        y += style.list_spacing.unwrap_or(0.);
                    }
                }
            }
        }
        let mut path = Path::default();
        let mut spans: Vec<TextSpan> = Vec::new();
        let figma_decoration = uses_figma_line_metrics(style);
        let mut underline_cache: Option<(String, u32, u64, f64, f64)> = None;
        for glyph in glyphs
            .iter_mut()
            .chain(list_marker_glyphs.iter_mut())
            .filter(|_| !matches!(output, OutlineOutput::None | OutlineOutput::Measurement))
        {
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
            if glyph.width_scale != 1. || glyph.height_scale != 1. || glyph.ink_offset != Point::default() {
                let (sx, sy) = (glyph.width_scale, glyph.height_scale);
                crate::text_path::transform_outline(&mut outline, crate::math::Transform([
                    sx, 0., 0., sy, glyph.x * (1. - sx) + glyph.ink_offset.x, glyph.y * (1. - sy) + glyph.ink_offset.y,
                ]));
            }
            if run.is_some_and(|r| r.italic) && !glyph_outline.italic_face {
                // Shear the ink about the shaped baseline. Layout advances
                // and decorations still follow the original line.
                let shear = 0.2;
                crate::text_path::transform_outline(&mut outline, crate::math::Transform([
                    1., 0., -shear, 1., shear * glyph.y, 0.,
                ]));
            }
            for (underline, enabled) in [
                (true, run.is_some_and(|r| r.underline)),
                (false, run.is_some_and(|r| r.strikethrough)),
            ] {
                if !enabled {
                    continue;
                }
                let legacy_h = (glyph.size / 16.).max(0.5);
                let (y, h) = if underline {
                    let legacy_y = glyph.y + glyph.size * 0.1;
                    if figma_decoration && glyph.width_scale == 1. && glyph.height_scale == 1. {
                        match figma_underline_for(self, glyph, &mut underline_cache) {
                            Some((top, thickness)) => (glyph.y + glyph.ink_offset.y + top, thickness),
                            None => (legacy_y, legacy_h),
                        }
                    } else {
                        (legacy_y, legacy_h)
                    }
                } else {
                    (glyph.y - glyph.size * 0.3, legacy_h)
                };
                let x = glyph.x;
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
            measurement,
            list_markers,
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
    #[cfg(target_os = "macos")]
    #[test]
    fn local_sketch_regular_han_uses_coretext_advances_without_exporting_the_face() {
        let mut local = fonts();
        let text = "系统";
        let utf16: Vec<_> = (0..=text.len()).map(|byte| byte / 3).collect();
        let style = TextStyle::default();
        let original = local.shape(text, 0, 46., &style, &[], &utf16, true).unwrap();
        assert!(original.iter().all(|glyph| glyph.font_id == "default"));
        local.enable_local_sketch_ui();
        let glyphs = local.shape(text, 0, 46., &style, &[], &utf16, true).unwrap();
        if system_sketch_ui_face(SKETCH_UI_DISPLAY_ID).is_none() {
            assert!(glyphs.iter().all(|glyph| glyph.font_id == "default"));
            return;
        }
        assert_eq!(glyphs.len(), 2);
        for glyph in glyphs {
            assert_eq!(glyph.font_id, SKETCH_UI_DISPLAY_ID);
            assert!((glyph.advance - 43.4492481203).abs() < 0.002, "{}", glyph.advance);
            assert!(!local.glyph_outline(&glyph).unwrap().commands.is_empty());
        }
        assert!(local.owned_face_bytes(SKETCH_UI_DISPLAY_ID).is_none());
        assert!(local.bytes(SKETCH_UI_DISPLAY_ID).is_err());
        assert!(local.named.is_empty());
        assert!(!valid_font_id(SKETCH_UI_DISPLAY_ID));
        let portable = local.shape(text, 0, 46., &style, &[], &utf16, false).unwrap();
        assert!(portable.iter().all(|glyph| glyph.font_id == "default"));
    }

    fn node(text: &str, style: serde_json::Value, width: f64) -> Node {
        serde_json::from_value(serde_json::json!({
            "id":"t", "kind":"text", "text":text, "fontSize":20,
            "width":width, "height":800, "textStyle":style,
            "fills":[{"kind":"solid","color":"#112233"}]
        }))
        .unwrap()
    }
    fn abeezee_bytes() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/abeezee/ABeeZee-Regular.ttf"
        ))
        .unwrap()
    }
    fn source_node(text: &str, source: &str) -> Node {
        let mut node = node(text, serde_json::json!({"fontId": "default"}), 1000.);
        node.bindings.insert(
            "sketchSourceFonts".into(),
            serde_json::json!({"style": source}).to_string(),
        );
        node
    }
    #[test]
    fn host_source_face_bytes_shape_default_text_and_keep_authored_identity() {
        let mut fonts = fonts();
        let mut node = source_node("Barlow 123", "ABeeZee-Regular");
        let portable = fonts.node_measure(&node, None).unwrap();
        assert!(
            portable.glyphs.iter().all(|glyph| glyph.font_id == "default"),
            "without host bytes the portable default font stays terminal"
        );
        let bytes = abeezee_bytes();
        let id = fonts
            .install_local_font("ABeeZee", Some("ABeeZee-Regular"), &bytes, 0)
            .unwrap();
        assert_eq!(
            fonts.local_face_id("ABeeZee-Regular"),
            Some(id.as_str()),
            "the host face is addressable by its source name"
        );
        assert_eq!(fonts.bytes(&id).unwrap(), bytes, "exact host bytes are retained");
        let resolved = fonts.node_measure(&node, None).unwrap();
        assert!((resolved.width - portable.width).abs() > 0.5, "shaping must use the resolved metrics");
        assert!(
            resolved.glyphs.iter().all(|glyph| glyph.font_id == id),
            "every covered cluster comes from the host face"
        );
        // Resolution is runtime-only: authored font id and provenance survive.
        assert_eq!(node.text_style.as_ref().unwrap().font_id, "default");
        assert!(node.bindings.contains_key("sketchSourceFonts"));
        assert!(!fonts.named.contains_key(&id));
        let document: crate::scene::Document = serde_json::from_value(serde_json::json!({
            "schemaVersion":16, "id":"d", "name":"d",
            "pages":[{"id":"p","name":"p","children":["t"],"background":"#ffffff"}],
            "nodes":{"t":node}, "fonts":{}
        }))
        .unwrap();
        let serialized = serde_json::to_string(&document).unwrap();
        assert!(!serialized.contains(HOST_FONT_ID_PREFIX));
        assert!(document.fonts.is_empty());
        assert_eq!(
            document.nodes["t"].bindings["sketchSourceFonts"],
            serde_json::json!({"style": "ABeeZee-Regular"}).to_string()
        );
    }
    #[test]
    fn bounded_host_resolver_loads_only_the_matching_font_file() {
        let dir = std::env::temp_dir().join(format!(
            "futureox-host-fonts-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ABeeZee-Regular.ttf"), abeezee_bytes()).unwrap();
        std::fs::write(dir.join("Unrelated-Medium.ttf"), abeezee_bytes()).unwrap();
        let mut fonts = fonts();
        let names = BTreeSet::from([
            "ABeeZee-Regular".to_string(),
            "NotInstalled-Medium".to_string(),
        ]);
        let installed = fonts.install_source_fonts_from_dirs(&[dir.clone()], &names);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(installed, 1, "one requested source face has host bytes");
        assert!(fonts.local_face_id("ABeeZee-Regular").is_some());
        assert!(fonts.local_face_id("NotInstalled-Medium").is_none());
        let node = source_node("Barlow 123", "ABeeZee-Regular");
        let layout = fonts.node_measure(&node, None).unwrap();
        assert!(layout.width.is_finite() && layout.width > 0.);
        assert!(layout.glyphs.iter().all(|glyph| glyph.font_id.starts_with(HOST_FONT_ID_PREFIX)));
        assert!(layout.glyphs.iter().all(|glyph| glyph.advance.is_finite()));
    }
    #[test]
    fn local_font_json_is_bounded_and_never_becomes_a_document_resource() {
        let payload = serde_json::json!([{
            "family": "ABeeZee",
            "postscript": "ABeeZee-Regular",
            "data": base64::engine::general_purpose::STANDARD.encode(abeezee_bytes()),
            "index": 0
        }])
        .to_string();
        let mut fonts = fonts();
        assert_eq!(fonts.install_local_fonts_json(&payload).unwrap(), 1);
        assert!(fonts.local_source_fonts_enabled());
        assert!(fonts.local_face_id("ABeeZee-Regular").is_some());
        assert!(fonts.named.is_empty());
        let oversized = serde_json::json!([{
            "family": "ABeeZee",
            "data": base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_HOST_FONT_BYTES + 1]),
            "index": 0
        }])
        .to_string();
        assert!(fonts.install_local_fonts_json(&oversized).is_err());
    }
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn document_source_names_resolve_from_host_files_without_changing_fonts() {
        let dir = std::env::temp_dir().join(format!(
            "futureox-host-doc-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ABeeZee-Regular.ttf"), abeezee_bytes()).unwrap();
        let document: crate::scene::Document = serde_json::from_value(serde_json::json!({
            "schemaVersion":16, "id":"d", "name":"d",
            "pages":[{"id":"p","name":"p","children":["t"],"background":"#ffffff"}],
            "nodes":{"t":{
                "id":"t","kind":"text","text":"KPI 123","fontSize":20,
                "width":400,"height":40,
                "textStyle":{"fontId":"default"},
                "textRuns":[{"start":0,"end":3,"fontId":"default"}]
            }},
            "designSystem":{"sketchContainers":{"nodeMetadata":{"t":{"bindings":{
                "sketchSourceFonts":"{\"style\":\"ABeeZee-Regular\",\"runs\":{\"0\":\"ABeeZee-Regular\"},\"fallbacks\":[\"ABeeZee-Regular\"]}"
            }}}}},
            "fonts":{}
        }))
        .unwrap();
        let mut fonts = fonts();
        fonts.enable_local_source_fonts();
        fonts.set_sketch_source_names(&document);
        let installed = fonts.resolve_sketch_source_fonts_from_dirs(&[dir.clone()]);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(installed, 1);
        let node = &document.nodes["t"];
        let layout = fonts.node_measure(node, None).unwrap();
        assert!(layout.glyphs.iter().all(|glyph| glyph.font_id.starts_with(HOST_FONT_ID_PREFIX)));
        assert!(layout.glyphs.iter().all(|glyph| glyph.advance.is_finite()));
        // The authored document, its font table and its provenance are intact.
        assert!(document.fonts.is_empty());
        let serialized = serde_json::to_string(&document).unwrap();
        assert!(!serialized.contains(HOST_FONT_ID_PREFIX));
        assert!(serialized.contains("sketchSourceFonts"));
        assert!(serialized.contains("ABeeZee-Regular"));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn engine_document_load_resolves_an_installed_system_source_face() {
        let mut engine = crate::Engine::new();
        engine.load_font(&font_bytes()).unwrap();
        engine.fonts.enable_local_source_fonts();
        let json = serde_json::json!({
            "schemaVersion":16, "id":"d", "name":"d",
            "pages":[{"id":"p","name":"p","children":["t"],"background":"#ffffff"}],
            "nodes":{"t":{
                "id":"t","kind":"text","text":"Helvetica 123","fontSize":20,
                "width":400,"height":40,
                "textStyle":{"fontId":"default"}
            }},
            "designSystem":{"sketchContainers":{"nodeMetadata":{"t":{"bindings":{
                "sketchSourceFonts":"{\"style\":\"Helvetica\"}"
            }}}}},
            "fonts":{}
        })
        .to_string();
        engine.load_document(&json).unwrap();
        let id = engine
            .fonts
            .local_face_id("Helvetica")
            .expect("macOS ships Helvetica")
            .to_owned();
        let node = &engine.doc.as_ref().unwrap().nodes["t"];
        let layout = engine.fonts.node_measure(node, None).unwrap();
        assert!(layout.glyphs.iter().any(|glyph| glyph.font_id == id));
        assert_eq!(node.text_style.as_ref().unwrap().font_id, "default");
        assert_eq!(engine.fonts.named.len(), 0);
    }
    #[test]
    fn mac_roman_name_fallback_requires_checked_ascii() {
        use ttf_parser::{PlatformId, name::Name};
        let record = Name {
            platform_id: PlatformId::Macintosh,
            encoding_id: 0,
            language_id: 0,
            name_id: ttf_parser::name_id::POST_SCRIPT_NAME,
            name: b"Helvetica",
        };
        assert_eq!(ascii_mac_roman_name(record), Some("Helvetica"));
        assert_eq!(ascii_mac_roman_name(Name { encoding_id: 1, ..record }), None);
        assert_eq!(ascii_mac_roman_name(Name { platform_id: PlatformId::Windows, ..record }), None);
        for value in [b"".as_slice(), b"  ", b"bad\0name", b"non\x80ascii", &[b'x'; 201]] {
            assert_eq!(ascii_mac_roman_name(Name { name: value, ..record }), None);
        }
    }
    fn line_glyphs<'a>(layout: &'a TextLayout, line: &TextLine) -> Vec<&'a Glyph> {
        layout
            .glyphs
            .iter()
            .filter(|g| line.start <= g.cluster && g.cluster < line.end)
            .collect()
    }
    #[test]
    fn measurement_uses_the_first_cap_and_last_baseline_after_vertical_alignment() {
        let fonts = fonts();
        let node = node("H\nH", serde_json::json!({ "verticalAlign": "bottom" }), 200.);
        let layout = fonts.node_layout(&node, Some(node.width)).unwrap();
        let measurement = fonts.node_text_measurement(&node).unwrap().unwrap();
        assert_eq!(measurement.baseline_y, layout.glyphs.last().unwrap().y);
        // Noto Sans SC: 733 cap-height units on a 1000-unit em.
        assert!((measurement.cap_y.unwrap() - (layout.glyphs[0].y - 20. * 0.733)).abs() < 1e-9);
        assert!(measurement.cap_y.unwrap() > 0.);
        assert!(measurement.baseline_y < node.height);
    }
    #[test]
    fn explicit_pixel_line_height_does_not_scale_with_the_font() {
        let fonts = fonts();
        let mut fixed = node("A\nB", serde_json::json!({
            "lineHeight": 1.5,
            "lineHeightPixels": 30.,
            "lineBoxBaseline": "figma-pixel-leading",
        }), 200.);
        let advance = |n: &Node| fonts.node_layout(n, Some(n.width)).unwrap().lines[0].height;
        assert_eq!(advance(&fixed), 30.);
        fixed.font_size = 40.;
        assert_eq!(advance(&fixed), 30.);
        fixed.text_style.as_mut().unwrap().line_height_pixels = None;
        assert_eq!(advance(&fixed), 60.);
    }

    #[test]
    fn authored_list_spacing_only_separates_neighboring_list_items() {
        let fonts = fonts();
        let text = "A\nB\nC";
        let plain = node(text, serde_json::json!({"listSpacing": 7.}), 200.);
        let default = node(text, serde_json::json!({}), 200.);
        let line_positions = |n: &Node| fonts.node_layout(n, Some(n.width)).unwrap()
            .lines.into_iter().map(|line| line.y).collect::<Vec<_>>();
        assert_eq!(line_positions(&plain), line_positions(&default));

        let mut list = node(text, serde_json::json!({"list":"bullet", "listSpacing": 7.}), 200.);
        list.text_runs = vec![TextRun {
            start: 4, end: 5, paragraph: Some(TextParagraph { list: "none".into(), ..Default::default() }),
            ..Default::default()
        }].into();
        let spaced = line_positions(&list);
        list.text_style.as_mut().unwrap().list_spacing = None;
        let base = line_positions(&list);
        assert_eq!(spaced.iter().zip(base).map(|(a,b)| a-b).collect::<Vec<_>>(), [0.,7.,7.]);
    }

    #[test]
    fn figma_pixel_line_box_keeps_fractional_half_leading() {
        let fonts = fonts();
        let ordinary = node("H", serde_json::json!({ "lineHeight": 1.05 }), 200.);
        let figma = node("H", serde_json::json!({
            "lineHeight": 1.05,
            "lineBoxBaseline": "figma-pixel-leading"
        }), 200.);
        let face = fonts.face("default", 400.).unwrap();
        let face = face.borrow_face();
        let units = f64::from(face.units_per_em());
        let natural = f64::from(face.ascender() - face.descender() + face.line_gap()) * 20. / units;
        let a = fonts.node_layout(&ordinary, Some(ordinary.width)).unwrap();
        let b = fonts.node_layout(&figma, Some(figma.width)).unwrap();
        assert_eq!(a.lines[0].height, 21.);
        assert_eq!(b.lines[0].height, a.lines[0].height);
        assert_eq!(b.glyphs[0].x, a.glyphs[0].x);
        assert!((b.glyphs[0].y - a.glyphs[0].y - (21. - natural) / 2.).abs() < 1e-9);
    }

    #[test]
    fn figma_auto_line_box_follows_the_faces_used_on_each_line() {
        let mut fonts = Fonts::new();
        fonts.load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/poppins/v2.000/Poppins-Bold.ttf"
        )).unwrap();
        let modern = include_bytes!(
            "../../../../frontend/design-client/public/fonts/poppins/Poppins-Bold.ttf"
        );
        let fonts = fonts.with_resources(&BTreeMap::from([("modern".into(), FontResource {
            family: "Poppins Bold".into(),
            data: base64::engine::general_purpose::STANDARD.encode(modern).into(),
            index: 0,
            postscript: Some("Poppins-Bold".into()),
        })])).unwrap();
        let mut n = node("B\nB", serde_json::json!({
            "lineHeight": 1.0,
            "lineHeightAuto": true,
            "lineBoxBaseline": "figma-font-metrics",
        }), 200.);
        n.font_size = 30.;
        let original = fonts.node_layout(&n, Some(n.width)).unwrap();
        assert_eq!(original.height, 98.);
        assert!((original.glyphs[0].y - 33.35).abs() < 1e-9);
        assert!((original.glyphs[1].y - 82.35).abs() < 1e-9);
        n.text_runs = vec![TextRun { start: 0, end: 3, font_id: Some("modern".into()), ..Default::default() }].into();
        let changed = fonts.node_layout(&n, Some(n.width)).unwrap();
        assert_eq!(changed.height, 90.);
        assert!(changed.glyphs[0].y < original.glyphs[0].y);
        n.text_style.as_mut().unwrap().line_height_auto = false;
        assert_eq!(fonts.node_layout(&n, Some(n.width)).unwrap().height, 60.);
    }

    #[test]
    fn figma_explicit_line_advances_and_soft_breaks_keep_the_authored_baselines() {
        let mut fonts = Fonts::new();
        fonts.load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/poppins/v2.000/Poppins-Bold.ttf"
        )).unwrap();
        let mut n = node("A\nB\u{2028}C\nD\u{2028}E", serde_json::json!({
            "lineHeight": 30. / 14.,
            "paragraphSpacing": 5.,
            "lineBoxBaseline": "figma-pixel-leading",
        }), 200.);
        n.font_size = 14.;
        n.text_runs = vec![
            TextRun { start: 0, end: 2, line_height: Some(30. / 14.), ..Default::default() },
            TextRun { start: 2, end: 9, line_height: Some(22. / 14.), ..Default::default() },
        ].into();
        let layout = fonts.node_layout(&n, Some(n.width)).unwrap();
        let baselines: Vec<_> = layout.lines.iter().map(|line| line_glyphs(&layout, line)[0].y).collect();
        assert_eq!(baselines.len(), 5);
        for ([a, b], advance) in baselines.array_windows().copied().zip([27., 22., 27., 22.]) {
            assert!((b - a - advance).abs() < 1e-8, "baselines: {baselines:?}");
        }
    }

    #[test]
    fn figma_explicit_height_centers_the_glyph_body_without_the_font_gap() {
        let mut fonts = Fonts::new();
        fonts.load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/poppins/Poppins-Regular.ttf"
        )).unwrap();
        let mut explicit = node("H\nH", serde_json::json!({
            "lineHeight": 20. / 14.,
            "lineHeightPixels": 20.,
            "lineBoxBaseline": "figma-pixel-leading",
        }), 200.);
        explicit.font_size = 14.;
        let measured = fonts.node_layout(&explicit, Some(explicit.width)).unwrap();
        assert_eq!(measured.lines[0].height, 20.);
        assert!((measured.glyphs[0].y - 14.9).abs() < 1e-9);
        assert!((measured.glyphs[1].y - 34.9).abs() < 1e-9);

        let style = explicit.text_style.as_mut().unwrap();
        style.line_height_pixels = None;
        style.line_height_auto = true;
        style.line_box_baseline = "figma-font-metrics".into();
        let automatic = fonts.node_layout(&explicit, Some(explicit.width)).unwrap();
        assert_eq!(automatic.lines[0].height, 21.);
        assert!((automatic.glyphs[0].y - 14.7).abs() < 1e-9);
    }

    #[test]
    fn figma_inter_keeps_the_positioning_adjustment_on_the_em_grid() {
        let mut fonts = Fonts::new();
        fonts.load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/inter/v3.19/Inter.ttf"
        )).unwrap();
        let mut text = node("Button", serde_json::json!({
            "lineBoxBaseline": "figma-font-metrics",
            "lineHeightAuto": true,
        }), 200.);
        text.font_size = 16.;
        let layout = fonts.node_layout(&text, Some(text.width)).unwrap();
        let xs = layout.glyphs.iter().map(|glyph| glyph.x).collect::<Vec<_>>();
        assert_eq!(xs, [0., 10.40625, 19.703125, 25.515625, 31.234375, 40.78125]);
        assert!((layout.glyphs[0].y - 15.318181818181818).abs() < 1e-9);
    }

    #[test]
    fn figma_advances_follow_source_grid_before_tracking() {
        let mut fonts = Fonts::new();
        fonts.load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/poppins/v2.000/Poppins-Bold.ttf"
        )).unwrap();
        let mut n = node("Pro", serde_json::json!({
            "letterSpacing": 1.,
            "lineBoxBaseline": "figma-pixel-leading",
        }), 200.);
        n.font_size = 30.;
        let figma = fonts.node_layout(&n, Some(n.width)).unwrap();
        assert_eq!(figma.glyphs[1].x, 20.130859375);
        assert_eq!(figma.glyphs[2].x, 33.845703125);
        n.text_style.as_mut().unwrap().line_box_baseline.clear();
        let plain = fonts.node_layout(&n, Some(n.width)).unwrap();
        assert!((plain.glyphs[1].x - 20.14).abs() < 1e-9);
    }

    #[test]
    fn figma_ink_rounds_the_baseline_without_moving_the_layout() {
        let mut fonts = Fonts::new();
        fonts.load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/poppins/v2.000/Poppins-Bold.ttf"
        )).unwrap();
        let mut n = node("P", serde_json::json!({
            "lineHeight": 1.0,
            "lineHeightAuto": true,
            "lineBoxBaseline": "figma-font-metrics",
        }), 200.);
        n.font_size = 30.;
        n.height = 49.;
        let snapped = fonts.node_layout(&n, Some(n.width)).unwrap();
        n.text_style.as_mut().unwrap().vertical_align = "bottom".into();
        let continuous = fonts.node_layout(&n, Some(n.width)).unwrap();
        assert!((snapped.glyphs[0].y - 33.35).abs() < 1e-9);
        assert_eq!(snapped.glyphs[0].y, continuous.glyphs[0].y);
        assert_eq!(snapped.height, continuous.height);
        let (Some(Command::Move(a)), Some(Command::Move(b))) =
            (snapped.path.commands.first(), continuous.path.commands.first())
        else { panic!("Poppins P has an outline"); };
        assert_eq!(a.x, b.x);
        assert!((a.y - b.y + 0.35).abs() < 1e-9);
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

    /// Explicit 150% is the same line box as a 1.5× pixel height. FIG pixel
    /// baselines in `01有料素材.fig` sit on the centered half-leading; a bare
    /// multiplier leaves that space below the baseline.
    #[test]
    fn explicit_percent_line_box_matches_fig_half_leading_pixels() {
        let mut fonts = Fonts::new();
        fonts.load(&poppins_v2("Bold")).unwrap();
        let face = fonts.face("default", 400.).unwrap();
        let face = face.borrow_face();
        let units = f64::from(face.units_per_em());
        let size = 30.;
        let natural =
            f64::from(face.ascender() - face.descender() + face.line_gap()) * size / units;
        let shift = (size * 1.5 - natural) / 2.;
        let mut plain = node(
            "H",
            serde_json::json!({"lineHeight": 1.5, "fontId": "default"}),
        );
        plain.font_size = size;
        plain.width = 80.;
        plain.height = 80.;
        plain.fills = vec![
            serde_json::from_value(serde_json::json!({"kind":"solid","color":"#112233"})).unwrap(),
        ];
        let mut centered = plain.clone();
        centered.text_style.as_mut().unwrap().line_box_baseline = "figma-pixel-leading".into();
        let below = fonts.node_layout(&plain, Some(80.)).unwrap();
        let half = fonts.node_layout(&centered, Some(80.)).unwrap();
        assert!(
            (half.glyphs[0].y - below.glyphs[0].y - shift).abs() < 1e-6,
            "half-leading shift {} measured {}",
            shift,
            half.glyphs[0].y - below.glyphs[0].y
        );

        fn render(sample: &Node, zoom: u32) -> Vec<u8> {
            let mut placed = sample.clone();
            placed.id = "t".into();
            placed.transform = crate::math::Transform([1., 0., 0., 1., 8., 8.]);
            placed.width = 80.;
            placed.height = 80.;
            let doc = serde_json::json!({
                "schemaVersion": 21,
                "id": "d",
                "name": "leading",
                "rasterProfile": "figma",
                "pages": [{"id":"p","name":"p","background":"#ffffff","children":["t"]}],
                "nodes": {"t": placed}
            });
            let mut engine = crate::Engine::new();
            engine.load_font(&poppins_v2("Bold")).unwrap();
            engine.load_document(&doc.to_string()).unwrap();
            let side = 96 * zoom;
            let options = serde_json::from_value(serde_json::json!({
                "pageId": "p",
                "width": side,
                "height": side,
                "view": {"x": 0, "y": 0, "zoom": zoom},
                "transparent": false,
                "grid": false,
                "rasterProfile": "figma"
            }))
            .unwrap();
            let pixels = engine.render(&options).unwrap();
            assert_eq!(pixels.len(), (side as usize).pow(2) * 4);
            pixels
        }
        fn diff(before: &[u8], after: &[u8]) -> (usize, u8) {
            assert_eq!(before.len(), after.len());
            let mut count = 0usize;
            let mut max = 0u8;
            for (left, right) in before.chunks(4).zip(after.chunks(4)) {
                let mut changed = false;
                for (a, b) in left.iter().zip(right) {
                    let delta = a.abs_diff(*b);
                    if delta > max {
                        max = delta;
                    }
                    changed |= delta != 0;
                }
                count += usize::from(changed);
            }
            (count, max)
        }
        fn sha(bytes: &[u8]) -> String {
            use sha2::{Digest, Sha256};
            Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        }
        for zoom in [1u32, 2] {
            let before = render(&plain, zoom);
            let after = render(&centered, zoom);
            let (count, max) = diff(&before, &after);
            eprintln!(
                "percent-leading zoom={zoom} differentPixels={count} maxChannel={max} beforeSha={} afterSha={}",
                sha(&before),
                sha(&after)
            );
            let (expect_count, expect_max, expect_before, expect_after) = match zoom {
                1 => (
                    126usize,
                    238u8,
                    "dc9dc10baf8b5a4f6ff72e09b9fb562f520a30f76a3c667b23d6d1c28937ea7d",
                    "1bfaee31d1b2b7349d6462929de8c6a07fb1ec182b1c5a7fde9de0e1ac565475",
                ),
                2 => (
                    445,
                    238,
                    "1b2948fa5a939f097fb6f0001153b7f15e35850402be3e0fc7ab2e1184bbe8c5",
                    "d4c41dfc7cd200f000756e46d3ebda0aea31d06a1097a6abfd12bfb17be210d4",
                ),
                _ => unreachable!(),
            };
            assert_eq!((count, max), (expect_count, expect_max), "zoom {zoom}");
            assert_eq!(sha(&before), expect_before, "zoom {zoom} uncentered");
            assert_eq!(sha(&after), expect_after, "zoom {zoom} half-leading");
        }
    }
}

#[cfg(test)]
mod figma_typography_fidelity {
    use super::*;

    fn noto() -> Fonts {
        let mut fonts = Fonts::new();
        fonts
            .load(
                &std::fs::read(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
                ))
                .unwrap(),
            )
            .unwrap();
        fonts
    }
    fn poppins_bold() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/poppins/v2.000/Poppins-Bold.ttf"
        ))
        .unwrap()
    }
    fn sha256(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
    fn cases() -> Vec<serde_json::Value> {
        serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../frontend/design-client/public/fidelity/text-2026-10-09/cases.json"
            ))
            .unwrap(),
        )
        .unwrap()
    }
    /// Axis-aligned filled rectangles added as Move/Line/Line/Line/Close.
    /// Glyph outlines for these faces are curves, so a thin quad is a decoration.
    fn rule_rects(path: &Path) -> Vec<(f64, f64, f64, f64)> {
        let mut rects = Vec::new();
        let commands = &path.commands;
        for index in 0..commands.len() {
            let Command::Move(a) = commands[index] else { continue };
            let Some(Command::Line(b)) = commands.get(index + 1) else { continue };
            let Some(Command::Line(c)) = commands.get(index + 2) else { continue };
            let Some(Command::Line(d)) = commands.get(index + 3) else { continue };
            if !matches!(commands.get(index + 4), Some(Command::Close)) {
                continue;
            }
            let xs = [a.x, b.x, c.x, d.x];
            let ys = [a.y, b.y, c.y, d.y];
            let (min_x, max_x) = xs.into_iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)));
            let (min_y, max_y) = ys.into_iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)));
            let on_box = xs.iter().all(|x| (*x - min_x).abs() < 1e-6 || (*x - max_x).abs() < 1e-6)
                && ys.iter().all(|y| (*y - min_y).abs() < 1e-6 || (*y - max_y).abs() < 1e-6);
            if on_box && max_x > min_x && max_y > min_y {
                rects.push((min_x, min_y, max_x - min_x, max_y - min_y));
            }
        }
        rects
    }
    fn line_box(fonts: &Fonts, size: f64) -> (f64, f64) {
        let parsed = fonts.face("default", 400.).unwrap();
        let face = parsed.borrow_face();
        let units = f64::from(face.units_per_em());
        let natural = (f64::from(face.ascender()) - f64::from(face.descender()) + f64::from(face.line_gap()))
            * size
            / units;
        let ascent = f64::from(face.ascender()) * size / units;
        (natural, ascent)
    }

    #[test]
    fn text_2026_10_09_keeps_figma_tracking_leading_and_runs() {
        let fonts = noto();
        let cases = cases();
        assert_eq!(cases.len(), 7);
        let loaded: Vec<_> = cases
            .iter()
            .map(|case| {
                let doc: crate::scene::Document = serde_json::from_value(case["document"].clone()).unwrap();
                (case["id"].as_str().unwrap().to_owned(), doc)
            })
            .collect();
        for (id, doc) in &loaded {
            let valid = doc.validate();
            for node in doc.nodes.values().filter(|node| node.kind == "text") {
                let layout = fonts.node_layout(node, Some(node.width)).unwrap();
                let style = node.text_style.as_deref();
                eprintln!(
                    "case={id} node={} font={} lineHeight={:?} auto={:?} lineBox={:?} letterSpacing={:?} runs={} line0h={} line0y={} glyph0y={} glyph0size={} width={} validate={}",
                    node.id,
                    node.font_size,
                    style.map(|s| s.line_height),
                    style.map(|s| s.line_height_auto),
                    style.map(|s| s.line_box_baseline.as_str()),
                    style.map(|s| s.letter_spacing),
                    node.text_runs.len(),
                    layout.lines[0].height,
                    layout.lines[0].y,
                    layout.glyphs[0].y,
                    layout.glyphs[0].size,
                    layout.width,
                    valid.as_ref().map(|_| "ok").unwrap_or("err"),
                );
            }
        }
        for (id, doc) in &loaded {
            let valid = doc.validate();
            assert!(valid.is_ok(), "{id} validate {}", valid.unwrap_err());
            let text = |name: &str| doc.nodes.get(name).unwrap().clone();
            match id.as_str() {
                "text-multiline" => {
                    let node = text("m1");
                    let style = node.text_style.as_deref().expect("140% line box");
                    assert!((style.line_height - 1.4).abs() < 1e-9, "{}", style.line_height);
                    assert_eq!(style.line_box_baseline, "figma-pixel-leading");
                    assert!(!style.line_height_auto);
                    let layout = fonts.node_layout(&node, Some(node.width)).unwrap();
                    assert!(layout.lines.iter().all(|line| (line.height - node.font_size * 1.4).abs() < 1e-6));
                    let mut bare = node.clone();
                    bare.text_style.as_mut().unwrap().line_box_baseline.clear();
                    let bare_y = fonts.node_layout(&bare, Some(bare.width)).unwrap().glyphs[0].y;
                    let (natural, _) = line_box(&fonts, node.font_size);
                    let shift = (node.font_size * 1.4 - natural) / 2.;
                    assert!(
                        (layout.glyphs[0].y - bare_y - shift).abs() < 1e-6,
                        "percent line box baseline {} uncentered {} shift {}",
                        layout.glyphs[0].y, bare_y, shift
                    );
                    assert!(shift.abs() > 0.2, "half-leading {shift}");
                }
                "text-letter-spacing" => {
                    for (name, spacing) in [("l1", 2.5), ("l2", -0.75)] {
                        let node = text(name);
                        let style = node.text_style.as_deref().expect("letter spacing");
                        assert!((style.letter_spacing - spacing).abs() < 1e-9, "{name}");
                        assert!(style.line_height_auto, "{name} still uses Figma Auto");
                        assert_eq!(style.line_box_baseline, "figma-font-metrics");
                        let laid = fonts.node_layout(&node, Some(node.width)).unwrap();
                        let mut bare = node.clone();
                        bare.text_style.as_mut().unwrap().letter_spacing = 0.;
                        let bare_w = fonts.node_layout(&bare, Some(bare.width)).unwrap().width;
                        let gaps = laid.glyphs.len().saturating_sub(1) as f64;
                        assert!(
                            (laid.width - bare_w - spacing * gaps).abs() < 1e-6,
                            "{name} width {} bare {bare_w} gaps {gaps}",
                            laid.width
                        );
                    }
                }
                "text-styled-runs" => {
                    assert!(doc.schema_version >= 4, "run color requires schema 4");
                    let node = text("r1");
                    assert_eq!(node.text_runs.len(), 2);
                    assert_eq!((node.text_runs[0].start, node.text_runs[0].end), (0, 6));
                    assert_eq!(node.text_runs[0].font_size, Some(30.));
                    assert_eq!(node.text_runs[0].color.as_deref(), Some("#c0392b"));
                    assert_eq!((node.text_runs[1].start, node.text_runs[1].end), (6, 17));
                    assert_eq!(node.text_runs[1].font_size, Some(18.));
                    let style = node.text_style.as_deref().unwrap();
                    assert!(style.line_height_auto);
                    assert_eq!(style.line_box_baseline, "figma-font-metrics");
                    let laid = fonts.node_layout(&node, Some(node.width)).unwrap();
                    assert!(laid.glyphs.iter().take(6).all(|glyph| glyph.size == 30.));
                    assert!(laid.glyphs.iter().skip(6).all(|glyph| glyph.size == 18.));
                    assert!(laid.spans.iter().any(|span| span.color.as_deref() == Some("#c0392b")));
                }
                _ => {
                    for node in doc.nodes.values().filter(|node| node.kind == "text") {
                        let style = node.text_style.as_deref().expect("Figma Auto line box");
                        assert!(style.line_height_auto, "{}", node.id);
                        assert_eq!(style.line_box_baseline, "figma-font-metrics");
                        assert_eq!(style.letter_spacing, 0.);
                        let laid = fonts.node_layout(node, Some(node.width)).unwrap();
                        let (natural, ascent) = line_box(&fonts, node.font_size);
                        let height = natural.round();
                        assert!((laid.lines[0].height - height).abs() < 1e-6, "{} height {} expected {height}", node.id, laid.lines[0].height);
                        assert!((height - node.font_size * 1.35).abs() > 0.5, "{} auto collapsed to 1.35", node.id);
                        let shift = (height - natural) / 2.;
                        assert!((laid.glyphs[0].y - (ascent + shift)).abs() < 1e-6, "{}", node.id);
                    }
                }
            }
        }
    }

    #[test]
    fn historical_underline_stays_on_the_em_fraction() {
        let fonts = noto();
        let mut node: Node = serde_json::from_value(serde_json::json!({
            "id":"t","kind":"text","text":"H","fontSize":16,"width":40,"height":40,
            "fills":[{"kind":"solid","color":"#112233"}],
            "textRuns":[{"start":0,"end":1,"underline":true}]
        }))
        .unwrap();
        node.text_style = Some(Box::new(TextStyle::default()));
        let layout = fonts.node_layout(&node, Some(node.width)).unwrap();
        let rects = rule_rects(&layout.path);
        assert_eq!(rects.len(), 1, "{rects:?}");
        let (x, y, w, h) = rects[0];
        assert!((x - layout.glyphs[0].x).abs() < 1e-9);
        assert!((y - (layout.glyphs[0].y + 16. * 0.1)).abs() < 1e-9, "y {y} baseline {}", layout.glyphs[0].y);
        assert!((h - 1.).abs() < 1e-9, "h {h}");
        assert!((w - layout.glyphs[0].advance).abs() < 1e-9);
    }

    #[test]
    fn youliao_underline_matches_fig_decoration_rect() {
        let fonts_for_perf = noto();
        let text = "Handgloves ".repeat(16);
        let mut plain: Node = serde_json::from_value(serde_json::json!({
            "id":"t","kind":"text","text":text,"fontSize":28,"width":4000,"height":80,
            "textStyle":{"lineHeight":1.4,"lineBoxBaseline":"figma-pixel-leading"},
            "fills":[{"kind":"solid","color":"#112233"}]
        }))
        .unwrap();
        let mut underlined = plain.clone();
        underlined.text_runs.push(TextRun {
            start: 0,
            end: text.encode_utf16().count(),
            underline: true,
            ..TextRun::default()
        });
        let time = |sample: &Node| {
            for _ in 0..2 {
                fonts_for_perf.node_layout(sample, Some(sample.width)).unwrap();
            }
            let start = std::time::Instant::now();
            for _ in 0..20 {
                fonts_for_perf.node_layout(sample, Some(sample.width)).unwrap();
            }
            start.elapsed().as_micros()
        };
        // Same constructed nodes on both binaries. Underline is the only branch
        // that reads font post metrics; plain text must stay on the old path.
        eprintln!(
            "perf plain_us={} underline_us={} iters=20 chars={}",
            time(&plain),
            time(&underlined),
            text.len()
        );
        let _ = plain;

        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../testing/fixtures/user-regression-20261109/01有料素材.fig"
        ))
        .unwrap();
        assert!(
            !bytes.starts_with(b"version https://git-lfs"),
            "01有料素材.fig is a Git LFS pointer"
        );
        assert_eq!(sha256(&bytes), "90eb4dc4d09b67cbcc7afa790bb373c28560f97e2111e8adfcfa269bc2afb82c");
        let doc = crate::interop::import_fig(&bytes).unwrap();
        let hits: Vec<_> = doc
            .nodes
            .values()
            .filter(|node| node.text == "U" && node.text_runs.iter().any(|run| run.underline))
            .collect();
        assert_eq!(hits.len(), 1, "underlined U nodes");
        let node = hits[0];
        let style = node.text_style.as_deref().unwrap();
        eprintln!(
            "imported U font={} weight={} lineHeight={} auto={} lineBox={} runs={:?}",
            node.font_size, style.weight, style.line_height, style.line_height_auto, style.line_box_baseline, node.text_runs
        );
        assert!((node.font_size - 13.).abs() < 1e-9);
        assert!((style.weight - 700.).abs() < 1e-6);
        assert!((style.line_height - 20. / 13.).abs() < 1e-9, "{}", style.line_height);
        assert!(!style.line_height_auto);
        assert_eq!(style.line_box_baseline, "figma-pixel-leading");
        assert_eq!(style.font_id, "default");
        let mut fonts = Fonts::new();
        fonts.load(&poppins_bold()).unwrap();
        let layout = fonts.node_layout(node, Some(node.width)).unwrap();
        assert_eq!(layout.glyphs.len(), 1);
        let glyph = &layout.glyphs[0];
        let rects = rule_rects(&layout.path);
        eprintln!(
            "underline baseline={} ink_y={} advance={} rects={rects:?}",
            glyph.y,
            glyph.y + glyph.ink_offset.y,
            glyph.advance
        );
        assert_eq!(rects.len(), 1, "{rects:?}");
        let (x, y, w, h) = rects[0];
        let mut placed = node.clone();
        placed.id = "t".into();
        placed.transform = crate::math::Transform([1., 0., 0., 1., 4., 2.]);
        let scene = serde_json::json!({
            "schemaVersion": doc.schema_version.max(4),
            "id": "d",
            "name": "underline",
            "rasterProfile": "figma",
            "pages": [{"id":"p","name":"p","background":"#ffffff","children":["t"]}],
            "nodes": {"t": placed}
        });
        let mut engine = crate::Engine::new();
        engine.load_font(&poppins_bold()).unwrap();
        engine.load_document(&scene.to_string()).unwrap();
        let options = serde_json::from_value(serde_json::json!({
            "pageId": "p", "width": 32, "height": 28,
            "view": {"x": 0, "y": 0, "zoom": 1},
            "transparent": false, "grid": false, "rasterProfile": "figma"
        }))
        .unwrap();
        let pixels = engine.render(&options).unwrap();
        eprintln!("underline-raster sha256={} bytes={}", sha256(&pixels), pixels.len());
        // 01有料素材.fig derivedTextData for this node: baseline position.y
        // 13.835, decoration rect {x:0, y:15.95, w:9.503, h:0.65}. Width follows
        // the shaped advance (0.731em). Height is post.underlineThickness.
        assert!((glyph.y - 13.835).abs() < 1e-4, "baseline {}", glyph.y);
        assert!((glyph.advance / 13. - 0.731).abs() <= 0.001, "em {}", glyph.advance / 13.);
        assert!(x.abs() < 1e-6, "x {x}");
        assert!((w - glyph.advance).abs() < 1e-9, "w {w} advance {}", glyph.advance);
        assert!((y - 15.95).abs() < 1e-6, "top {y}");
        assert!((h - 0.65).abs() < 1e-6, "thickness {h}");
    }
}

#[cfg(test)]
mod list_tests {
    use super::*;

    fn fonts() -> Fonts {
        let mut fonts = Fonts::new();
        fonts
            .load(&std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
            ))
            .unwrap())
            .unwrap();
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

    fn paragraph(value: TextParagraph) -> TextRun {
        TextRun { paragraph: Some(value), ..TextRun::default() }
    }

    #[test]
    fn a_bullet_item_keeps_its_glyph_table_and_lines_and_paints_a_marker() {
        let fonts = fonts();
        let plain = fonts.node_layout(&node("One\nTwo", serde_json::json!({}), 400.), None).unwrap();
        let listed = fonts
            .node_layout(&node("One\nTwo", serde_json::json!({"list":"bullet"}), 400.), None)
            .unwrap();
        assert!(plain.list_markers.is_empty());
        assert_eq!(
            listed.list_markers.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["\u{2022}", "\u{2022}"]
        );
        // The authored text is laid out as before, only further right.
        assert_eq!(listed.glyphs.len(), plain.glyphs.len());
        assert_eq!(listed.glyphs.len(), 6);
        for (a, b) in plain.glyphs.iter().zip(&listed.glyphs) {
            assert_eq!((a.cluster, a.cluster_end), (b.cluster, b.cluster_end));
            assert!((a.y - b.y).abs() < 1e-9 && (a.advance - b.advance).abs() < 1e-9,
                "plain ({}, {}, {}) listed ({}, {}, {})", a.cluster, a.y, a.advance, b.cluster, b.y, b.advance);
        }
        let shift = listed.glyphs[0].x - plain.glyphs[0].x;
        assert!(shift > 20. && shift < 60., "marker gutter {shift}");
        for (a, b) in plain.lines.iter().zip(&listed.lines) {
            assert_eq!((a.start, a.end), (b.start, b.end));
            assert!((a.y - b.y).abs() < 1e-9 && (a.height - b.height).abs() < 1e-9);
        }
        for marker in &listed.list_markers {
            assert!(marker.x >= 0. && marker.x < listed.glyphs[0].x, "the marker precedes its text");
        }
        // Each marker sits on the baseline of its own first line.
        assert!((listed.list_markers[1].y - listed.list_markers[0].y - (listed.lines[1].y - listed.lines[0].y)).abs() < 1e-9);
        assert!((listed.list_markers[0].y - listed.glyphs[0].y).abs() < 1e-9);
        assert!(listed.width > plain.width);
        assert!(listed.path.commands.len() > plain.path.commands.len(), "the marker outlines are painted");
    }

    #[test]
    fn a_wrapped_item_starts_every_line_after_the_marker() {
        let fonts = fonts();
        let text = "alpha beta gamma delta epsilon zeta";
        let listed = fonts
            .node_layout(&node(text, serde_json::json!({"list":"ordered","wrap":true}), 150.), Some(150.))
            .unwrap();
        assert!(listed.lines.len() >= 2, "the item wraps");
        assert_eq!(listed.list_markers.len(), 1);
        assert_eq!(listed.list_markers[0].text, "1.");
        let starts: Vec<f64> = listed
            .lines
            .iter()
            .map(|line| listed.glyphs.iter().find(|g| g.cluster >= line.start).unwrap().x)
            .collect();
        assert!(starts.windows(2).all(|w| (w[0] - w[1]).abs() < 1e-9), "every line starts at the item text: {starts:?}");
        // The text column is narrower than the box by the marker gutter, so the
        // item wraps at least as much as the plain text in the whole box.
        assert!(starts[0] > 0.);
        let plain = fonts.node_layout(&node(text, serde_json::json!({"wrap":true}), 150.), Some(150.)).unwrap();
        assert!(listed.lines.len() >= plain.lines.len(), "{} {}", listed.lines.len(), plain.lines.len());
    }

    #[test]
    fn ordered_items_are_numbered_until_a_plain_paragraph_or_a_bullet() {
        let fonts = fonts();
        let mut n = node("a\nb\nc\nd\ne", serde_json::json!({"list":"ordered"}), 400.);
        // "c" leaves the list and "d" is a bullet; both restart the numbering.
        n.text_runs = vec![
            TextRun { start: 4, end: 5, ..paragraph(TextParagraph { list: "none".into(), ..TextParagraph::default() }) },
            TextRun { start: 6, end: 7, ..paragraph(TextParagraph { list: "bullet".into(), ..TextParagraph::default() }) },
        ];
        let layout = fonts.node_layout(&n, None).unwrap();
        let texts: Vec<_> = layout.list_markers.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["1.", "2.", "\u{2022}", "1."]);
    }

    #[test]
    fn a_nested_item_indents_further_and_numbers_its_own_level() {
        let fonts = fonts();
        let mut n = node("a\nb\nc\nd", serde_json::json!({"list":"ordered"}), 400.);
        let nested = || TextParagraph { list: "ordered".into(), list_level: Some(1), ..TextParagraph::default() };
        n.text_runs = vec![TextRun { start: 2, end: 3, ..paragraph(nested()) }, TextRun { start: 4, end: 5, ..paragraph(nested()) }];
        let layout = fonts.node_layout(&n, None).unwrap();
        let markers: Vec<(&str, f64)> = layout.list_markers.iter().map(|m| (m.text.as_str(), m.x)).collect();
        assert_eq!(markers.iter().map(|m| m.0).collect::<Vec<_>>(), ["1.", "1.", "2.", "2."]);
        assert!(markers[1].1 > markers[0].1 + 20., "the nested marker sits further right: {markers:?}");
        let x: Vec<f64> = layout.lines.iter().map(|line| layout.glyphs.iter().find(|g| g.cluster >= line.start).unwrap().x).collect();
        assert!(x[1] > x[0] + 20. && x[2] > x[0] + 20. && (x[3] - x[0]).abs() < 1e-9 && (x[2] - x[1]).abs() < 1e-9,
            "nested items indent and the outer level returns: {x:?}");
    }

    #[test]
    fn a_centred_item_centres_its_text_inside_the_remaining_column() {
        let fonts = fonts();
        let left = fonts.node_layout(&node("ab", serde_json::json!({"list":"bullet","wrap":true}), 400.), Some(400.)).unwrap();
        let centre = fonts.node_layout(&node("ab", serde_json::json!({"list":"bullet","wrap":true,"align":"center"}), 400.), Some(400.)).unwrap();
        let indent = left.glyphs[0].x;
        assert!(indent > 0.);
        let first = centre.glyphs[0].x;
        let last = centre.glyphs.iter().map(|g| g.x + g.advance).fold(0., f64::max);
        assert!(((first + last) / 2. - (indent + 400.) / 2.).abs() < 1e-9, "centred after the gutter");
    }

    fn ink(path: &Path) -> Vec<Point> {
        path.commands
            .iter()
            .flat_map(|command| match command {
                crate::path::Command::Move(p) | crate::path::Command::Line(p) => vec![*p],
                crate::path::Command::Quad(a, b) => vec![*a, *b],
                crate::path::Command::Cubic(a, b, c) => vec![*a, *b, *c],
                _ => vec![],
            })
            .collect()
    }

    #[test]
    fn a_marker_of_several_glyphs_is_painted_in_sequence() {
        let fonts = fonts();
        let text = (1..=10).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let layout = fonts
            .node_layout(&node(&text, serde_json::json!({"list":"ordered"}), 400.), None)
            .unwrap();
        let marker = layout.list_markers.last().unwrap();
        assert_eq!(marker.text, "10.");
        let period = fonts.node_layout(&node(".", serde_json::json!({}), 400.), None).unwrap().glyphs.remove(0);
        let line = layout.lines.last().unwrap();
        let text_x = layout.glyphs.iter().find(|g| g.cluster >= line.start).unwrap().x;
        // The gap after a marker is half an em and the period ends the marker.
        let period_start = text_x - 10. - period.advance;
        let painted: Vec<f64> = ink(&layout.path)
            .into_iter()
            .filter(|p| p.x >= period_start && p.x < text_x - 10. && p.y <= marker.y && p.y > marker.y - period.size / 2.)
            .map(|p| p.x)
            .collect();
        assert!(!painted.is_empty(), "the period is painted after the digits");
        assert!(painted.iter().all(|x| *x < period_start + period.advance), "the period keeps its advance: {painted:?}");
    }

    #[test]
    fn an_empty_item_keeps_its_number_on_the_baseline_of_its_line() {
        let fonts = fonts();
        let listed = |text: &str| {
            fonts
                .node_layout(&node(text, serde_json::json!({"list":"ordered"}), 400.), None)
                .unwrap()
        };
        let full = listed("a\nb\nc");
        assert_eq!(
            full.list_markers.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["1.", "2.", "3."]
        );
        let expected: Vec<f64> = full.list_markers.iter().map(|m| m.y).collect();
        for text in ["\nb\nc", "a\n\nc", "a\nb\n"] {
            let layout = listed(text);
            assert_eq!(layout.list_markers.len(), 3, "{text:?}");
            assert_eq!(layout.lines.len(), 3, "{text:?}");
            let y: Vec<f64> = layout.list_markers.iter().map(|m| m.y).collect();
            assert!(y.iter().zip(&expected).all(|(a, b)| (a - b).abs() < 1e-9), "{text:?}: {y:?} vs {expected:?}");
        }
    }

    #[test]
    fn a_marker_takes_the_style_of_its_own_paragraph() {
        let fonts = fonts();
        let mut n = node("ab\ncd", serde_json::json!({"list":"bullet"}), 400.);
        n.text_runs = vec![TextRun { start: 3, end: 5, color: Some("#ff0000".into()), ..TextRun::default() }];
        let layout = fonts.node_layout(&n, None).unwrap();
        let last = layout.spans.last().unwrap();
        assert_eq!(last.color.as_deref(), Some("#ff0000"));
        assert!(!last.outline.commands.is_empty(), "the red span carries the marker of the second item");
    }

    #[test]
    fn vertical_text_on_a_path_or_right_to_left_keeps_its_layout_without_markers() {
        let fonts = fonts();
        let vertical = fonts
            .node_layout(&node("ab\ncd", serde_json::json!({"list":"bullet","writingMode":"vertical"}), 400.), None)
            .unwrap();
        assert!(vertical.list_markers.is_empty());
        let rtl = fonts
            .node_layout(&node("ab\ncd", serde_json::json!({"list":"bullet","direction":"rtl"}), 400.), None)
            .unwrap();
        assert!(rtl.list_markers.is_empty());
    }
}
