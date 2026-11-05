//! Bounded, read-only native font discovery. Only listed opaque handles can be
//! read; the renderer never supplies a font path. Collection faces are relocated
//! to standalone sfnt resources without altering glyph/layout table data.
use crate::{BackendError, Result, font_collection, hash, storage};
use base64::Engine as _;
use serde::Serialize;
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};

pub const MAX_FONT_BYTES: usize = 20 * 1024 * 1024;
#[derive(Clone, Copy)]
struct Limits {
    entries: usize,
    fonts: usize,
    bytes: usize,
    depth: usize,
}
const LIMITS: Limits = Limits {
    entries: 4096,
    fonts: 1024,
    bytes: 1024 * 1024 * 1024,
    depth: 4,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontAxis {
    pub tag: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Font {
    pub id: String,
    pub family: String,
    pub style: String,
    pub postscript: String,
    pub index: u32,
    pub source_index: u32,
    /// OS/2 usWeightClass. Variable faces still report the default instance.
    pub weight: u16,
    pub italic: bool,
    pub variable: bool,
    /// Empty for static faces. `wght` is the axis the text weight field drives.
    pub axes: Vec<FontAxis>,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontList {
    pub fonts: Vec<Font>,
    pub truncated: bool,
    pub skipped_collections: usize,
    pub skipped_invalid: usize,
    pub skipped_too_large: usize,
    pub unavailable_directories: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontData {
    pub font: Font,
    pub data: String,
    pub index: u32,
    pub source_index: u32,
    pub extracted: bool,
}
#[derive(Clone)]
struct Grant {
    path: PathBuf,
    digest: String,
    font: Font,
    collection: bool,
}
pub struct FontCatalog {
    roots: Option<Vec<PathBuf>>,
    grants: Mutex<HashMap<String, Grant>>,
    limits: Limits,
}
fn error(code: &'static str, message: &str) -> BackendError {
    BackendError::new(code, message)
}
fn stale() -> BackendError {
    error(
        "FONT_CHANGED",
        "This font changed or is no longer available. Refresh the font list before importing.",
    )
}
fn name(face: &ttf_parser::Face<'_>, ids: &[u16]) -> Option<String> {
    for id in ids {
        let mut fallback = None;
        for name in face.names().into_iter().filter(|name| name.name_id == *id) {
            let Some(text) = name.to_string() else {
                continue;
            };
            let text = text.trim();
            if text.is_empty() || text.chars().any(char::is_control) || text.chars().count() > 200 {
                continue;
            }
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
    None
}
fn describe(bytes: &[u8], id: String, source_index: u32) -> Result<Font> {
    let face = ttf_parser::Face::parse(bytes, source_index)
        .map_err(|_| error("FONT_INVALID", "The font face could not be parsed"))?;
    let family = name(
        &face,
        &[
            ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
            ttf_parser::name_id::FAMILY,
        ],
    )
    .ok_or_else(|| error("FONT_INVALID", "The font has no supported family name"))?;
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
        axes.push(FontAxis {
            tag,
            min: axis.min_value,
            default: axis.def_value,
            max: axis.max_value,
        });
    }
    Ok(Font {
        id,
        family,
        style: name(
            &face,
            &[
                ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY,
                ttf_parser::name_id::SUBFAMILY,
            ],
        )
        .unwrap_or_else(|| "Regular".into()),
        postscript: name(&face, &[ttf_parser::name_id::POST_SCRIPT_NAME]).unwrap_or_default(),
        index: source_index,
        source_index,
        weight: face.weight().to_number(),
        italic: face.is_italic() || face.is_oblique(),
        variable: face.is_variable(),
        axes,
    })
}
/// Directories scanned for TTF/OTF/TTC/OTC. Paths are fixed per platform; the
/// RPC never accepts a caller-supplied directory. fontconfig files outside
/// these roots are not consulted.
pub(crate) fn system_roots() -> Option<Vec<PathBuf>> {
    let mut roots = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/System/Library/Fonts"));
        roots.push(PathBuf::from("/Library/Fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            if home.is_absolute() {
                roots.push(home.join("Library/Fonts"));
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        roots.push(PathBuf::from("/usr/local/share/fonts"));
        roots.push(PathBuf::from("/usr/share/fonts"));
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            let xdg = PathBuf::from(xdg);
            if xdg.is_absolute() {
                roots.push(xdg.join("fonts"));
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            if home.is_absolute() {
                roots.push(home.join(".local/share/fonts"));
                roots.push(home.join(".fonts"));
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(windir) = std::env::var_os("WINDIR") {
            let windir = PathBuf::from(windir);
            if windir.is_absolute() {
                roots.push(windir.join("Fonts"));
            }
        }
        if !roots.iter().any(|path| path.ends_with("Fonts")) {
            roots.push(PathBuf::from(r"C:\Windows\Fonts"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            if local.is_absolute() {
                roots.push(local.join("Microsoft").join("Windows").join("Fonts"));
            }
        }
    }
    if roots.is_empty() {
        None
    } else {
        Some(roots)
    }
}
impl Default for FontCatalog {
    fn default() -> Self {
        Self::system()
    }
}
impl FontCatalog {
    pub fn system() -> Self {
        Self {
            roots: system_roots(),
            grants: Mutex::new(HashMap::new()),
            limits: LIMITS,
        }
    }
    /// Trusted host/test construction only; no RPC accepts directory paths.
    pub fn for_directories(roots: Vec<PathBuf>) -> Self {
        Self {
            roots: Some(roots),
            grants: Mutex::new(HashMap::new()),
            limits: LIMITS,
        }
    }
    pub fn list(&self) -> Result<FontList> {
        let roots = self.roots.as_ref().ok_or_else(||error("FONT_PLATFORM_UNSUPPORTED", "System font discovery supports macOS, Windows and Linux font directories. Other platforms keep portable embedded fonts."))?;
        let mut output = FontList::default();
        let mut stack = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut canonical_roots = Vec::new();
        for root in roots {
            match root.canonicalize() {
                Ok(root) if root.is_dir() => {
                    if seen.insert(root.clone()) {
                        canonical_roots.push(root.clone());
                        stack.push((root, 0));
                    }
                }
                _ => output.unavailable_directories += 1,
            }
        }
        // Reverse the stack to inspect trusted roots in their declared order.
        stack.reverse();
        let mut entries = 0usize;
        let mut scanned_bytes = 0usize;
        let mut grants = HashMap::new();
        let mut seen_files = std::collections::HashSet::new();
        'scan: while let Some((directory, depth)) = stack.pop() {
            let listing = match fs::read_dir(&directory) {
                Ok(listing) => listing,
                Err(_) => {
                    output.unavailable_directories += 1;
                    continue;
                }
            };
            for item in listing {
                if entries >= self.limits.entries || output.fonts.len() >= self.limits.fonts {
                    output.truncated = true;
                    break 'scan;
                }
                entries += 1;
                let item = match item {
                    Ok(item) => item,
                    Err(_) => {
                        output.skipped_invalid += 1;
                        continue;
                    }
                };
                let path = item.path();
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        output.skipped_invalid += 1;
                        continue;
                    }
                };
                // File symlinks are readable only when they resolve to a regular
                // file inside a configured root. Directory symlinks are not
                // walked, so a link cannot escape the root.
                let canonical = match path.canonicalize() {
                    Ok(path) => path,
                    Err(_) => {
                        output.skipped_invalid += 1;
                        continue;
                    }
                };
                if metadata.file_type().is_symlink() {
                    let inside = canonical.is_file()
                        && canonical_roots
                            .iter()
                            .any(|root| canonical.starts_with(root));
                    if !inside {
                        output.skipped_invalid += 1;
                        continue;
                    }
                } else if canonical != path {
                    output.skipped_invalid += 1;
                    continue;
                }
                if metadata.is_dir() {
                    if depth < self.limits.depth {
                        if seen.insert(path.clone()) {
                            stack.push((path, depth + 1));
                        }
                    } else {
                        output.truncated = true;
                    }
                    continue;
                }
                let linked = metadata.file_type().is_symlink();
                if !linked && !metadata.is_file() {
                    continue;
                }
                let file_path = if linked { canonical } else { path.clone() };
                if !seen_files.insert(file_path.clone()) {
                    continue;
                }
                let extension = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if !["ttf", "otf", "ttc", "otc"].contains(&extension.as_str()) {
                    continue;
                }
                let read_limit = if ["ttc", "otc"].contains(&extension.as_str()) {
                    font_collection::MAX_COLLECTION_BYTES
                } else {
                    MAX_FONT_BYTES
                };
                let file_len = if linked {
                    match fs::metadata(&file_path) {
                        Ok(metadata) if metadata.is_file() => metadata.len(),
                        _ => {
                            output.skipped_invalid += 1;
                            continue;
                        }
                    }
                } else {
                    metadata.len()
                };
                if file_len > read_limit as u64 {
                    output.skipped_too_large += 1;
                    continue;
                }
                if file_len > self.limits.bytes.saturating_sub(scanned_bytes) as u64 {
                    output.truncated = true;
                    break 'scan;
                }
                let bytes = match storage::read_bounded(&file_path, read_limit) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        output.skipped_invalid += 1;
                        continue;
                    }
                };
                if bytes.len() > self.limits.bytes.saturating_sub(scanned_bytes) {
                    output.truncated = true;
                    break 'scan;
                }
                scanned_bytes += bytes.len();
                let digest = hash(&bytes);
                let collection = bytes.starts_with(b"ttcf");
                let faces = match font_collection::face_count(&bytes) {
                    Ok(faces) => faces,
                    Err(_) if collection => {
                        output.skipped_collections += 1;
                        continue;
                    }
                    Err(_) => {
                        output.skipped_invalid += 1;
                        continue;
                    }
                };
                let mut unsupported_collection = false;
                for source_index in 0..faces {
                    if output.fonts.len() >= self.limits.fonts {
                        output.truncated = true;
                        break 'scan;
                    }
                    let id =
                        hash(format!("{}\0{digest}\0{source_index}", path.display()).as_bytes());
                    let font = (|| {
                        if collection {
                            font_collection::plan(&bytes, source_index)?;
                        }
                        describe(&bytes, id.clone(), source_index)
                    })();
                    match font {
                        Ok(font) => {
                            grants.insert(
                                id,
                                Grant {
                                    path: file_path.clone(),
                                    digest: digest.clone(),
                                    font: font.clone(),
                                    collection,
                                },
                            );
                            output.fonts.push(font);
                        }
                        Err(error) if error.code == "FONT_COLLECTION_UNSUPPORTED" => {
                            unsupported_collection = true
                        }
                        Err(error) if error.code == "FONT_TOO_LARGE" => {
                            output.skipped_too_large += 1
                        }
                        Err(_) => output.skipped_invalid += 1,
                    }
                }
                if unsupported_collection {
                    output.skipped_collections += 1;
                }
            }
        }
        output.fonts.sort_by(|a, b| {
            (&a.family, &a.style, &a.postscript, &a.id).cmp(&(
                &b.family,
                &b.style,
                &b.postscript,
                &b.id,
            ))
        });
        *self
            .grants
            .lock()
            .map_err(|_| error("FONT_UNAVAILABLE", "Font catalog is unavailable"))? = grants;
        Ok(output)
    }
    pub fn read(&self, id: &str) -> Result<FontData> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error(
                "INVALID_REQUEST",
                "A listed opaque font ID is required",
            ));
        }
        let grant = self
            .grants
            .lock()
            .map_err(|_| error("FONT_UNAVAILABLE", "Font catalog is unavailable"))?
            .get(id)
            .cloned()
            .ok_or_else(|| {
                error(
                    "FONT_NOT_FOUND",
                    "Refresh the system font list and select a listed font",
                )
            })?;
        if grant.path.canonicalize().ok().as_ref() != Some(&grant.path) {
            return Err(stale());
        }
        let limit = if grant.collection {
            font_collection::MAX_COLLECTION_BYTES
        } else {
            MAX_FONT_BYTES
        };
        let bytes = storage::read_bounded(&grant.path, limit).map_err(|_| stale())?;
        if hash(&bytes) != grant.digest {
            return Err(stale());
        }
        let bytes = if grant.collection {
            font_collection::extract(&bytes, grant.font.source_index)?
        } else {
            bytes
        };
        Ok(FontData {
            index: 0,
            source_index: grant.font.source_index,
            extracted: grant.collection,
            font: grant.font,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "forma-fonts-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn font(&self) -> PathBuf {
            let target = self.0.join("fixture.ttf");
            fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf"),
                &target,
            )
            .unwrap();
            target
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn listed_font_bytes_are_exact_and_paths_are_not_renderer_capabilities() {
        let f = Fixture::new();
        let path = f.font();
        let catalog = FontCatalog::for_directories(vec![f.0.clone()]);
        assert!(catalog.read(path.to_str().unwrap()).is_err());
        let result = catalog.list().unwrap();
        assert_eq!(result.fonts.len(), 1);
        assert!(!result.truncated);
        assert!(result.fonts[0].family.contains("Noto Sans SC"));
        let read = catalog.read(&result.fonts[0].id).unwrap();
        assert_eq!(read.font.index, 0);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(read.data)
                .unwrap(),
            fs::read(&path).unwrap()
        );
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains(f.0.to_str().unwrap())
        );
        assert!(catalog.read(&"0".repeat(64)).is_err());
        fs::write(&path, b"changed").unwrap();
        assert_eq!(
            catalog.read(&result.fonts[0].id).unwrap_err().code,
            "FONT_CHANGED"
        );
    }
    #[test]
    fn collections_invalid_and_oversized_fonts_are_explicit() {
        let f = Fixture::new();
        fs::write(f.0.join("collection.ttc"), b"ttcf").unwrap();
        fs::write(f.0.join("renamed.ttf"), b"ttcf").unwrap();
        fs::write(f.0.join("invalid.otf"), b"not a font").unwrap();
        fs::File::create(f.0.join("oversized.ttf"))
            .unwrap()
            .set_len(MAX_FONT_BYTES as u64 + 1)
            .unwrap();
        let result = FontCatalog::for_directories(vec![f.0.clone()])
            .list()
            .unwrap();
        assert_eq!(result.skipped_collections, 2);
        assert_eq!(result.skipped_invalid, 1);
        assert_eq!(result.skipped_too_large, 1);
        assert!(result.fonts.is_empty());
    }
    #[test]
    fn collection_catalog_selects_the_requested_face_and_rechecks_source_hash() {
        let f = Fixture::new();
        let source = crate::font_collection::two_face_fixture();
        let path = f.0.join("two-faces.ttc");
        fs::write(&path, &source).unwrap();
        let catalog = FontCatalog::for_directories(vec![f.0.clone()]);
        let result = catalog.list().unwrap();
        assert_eq!(result.fonts.len(), 2);
        assert_eq!(result.skipped_collections, 0);
        assert_ne!(result.fonts[0].id, result.fonts[1].id);
        let one = result
            .fonts
            .iter()
            .find(|font| font.source_index == 1)
            .unwrap();
        assert_eq!(one.index, 1);
        assert!(one.family.contains("Moto"));
        let imported = catalog.read(&one.id).unwrap();
        assert_eq!(imported.index, 0);
        assert_eq!(imported.source_index, 1);
        assert!(imported.extracted);
        let extracted = base64::engine::general_purpose::STANDARD
            .decode(imported.data)
            .unwrap();
        let face = ttf_parser::Face::parse(&extracted, 0).unwrap();
        assert_eq!(
            name(
                &face,
                &[
                    ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
                    ttf_parser::name_id::FAMILY
                ]
            )
            .unwrap(),
            one.family
        );
        let mut changed = source;
        changed[4] = 3;
        fs::write(&path, changed).unwrap();
        assert_eq!(catalog.read(&one.id).unwrap_err().code, "FONT_CHANGED");
    }

    /// Explicit opt-in real-system read only check; ordinary fixture tests stay
    /// portable and do not depend on what fonts happen to be installed.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires installed macOS collection fonts; run explicitly for local acceptance"]
    fn mac_collection_face_loads_and_shapes_in_existing_kernel() {
        let path = std::path::Path::new("/System/Library/Fonts/Hiragino Sans GB.ttc");
        let source = storage::read_bounded(path, font_collection::MAX_COLLECTION_BYTES).unwrap();
        let mut checked = None;
        for index in 0..font_collection::face_count(&source).unwrap() {
            let Ok(extracted) = font_collection::extract(&source, index) else {
                continue;
            };
            let metadata = describe(&source, "fixture".into(), index).unwrap();
            let mut engine = futureox_design_kernel::renderer::Engine::new();
            engine.load_font(&extracted).unwrap();
            let node: futureox_design_kernel::scene::Node = serde_json::from_value(serde_json::json!({"id":"text","kind":"text","width":400,"height":50,"text":"本地精确画布 ABC","fontSize":24})).unwrap();
            let layout = engine.fonts.node_layout(&node, None).unwrap();
            assert!(!layout.glyphs.is_empty());
            assert!(layout.width > 0.);
            assert!(!layout.path.commands.is_empty());
            checked = Some((
                index,
                metadata.family,
                metadata.style,
                extracted.len(),
                layout.glyphs.len(),
            ));
            // Prefer a nonzero source face to prove face-zero-only kernel support
            // does not accidentally select the first collection face.
            if index > 0 {
                break;
            }
        }
        let checked = checked.expect("A bounded unsigned Hiragino Sans GB face must import");
        eprintln!(
            "MAC_COLLECTION_KERNEL {{ sourceIndex: {}, family: {:?}, style: {:?}, bytes: {}, glyphs: {} }}",
            checked.0, checked.1, checked.2, checked.3, checked.4
        );
    }
    #[test]
    fn entry_depth_and_total_read_budgets_report_partial_results() {
        let f = Fixture::new();
        let path = f.font();
        let mut catalog = FontCatalog::for_directories(vec![f.0.clone()]);
        catalog.limits.bytes = 1;
        assert!(catalog.list().unwrap().truncated);
        catalog.limits = LIMITS;
        catalog.limits.entries = 0;
        assert!(catalog.list().unwrap().truncated);
        fs::remove_file(path).unwrap();
        fs::create_dir(f.0.join("child")).unwrap();
        catalog.limits = LIMITS;
        catalog.limits.depth = 0;
        assert!(catalog.list().unwrap().truncated);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_files_are_never_imported() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let path = f.font();
        let other = Fixture::new();
        symlink(&path, other.0.join("link.ttf")).unwrap();
        let result = FontCatalog::for_directories(vec![other.0.clone()])
            .list()
            .unwrap();
        assert!(result.fonts.is_empty());
        assert_eq!(result.skipped_invalid, 1);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_inside_the_root_is_listed_once() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let path = f.font();
        symlink(&path, f.0.join("alias.ttf")).unwrap();
        let catalog = FontCatalog::for_directories(vec![f.0.clone()]);
        let listed = catalog.list().unwrap();
        assert_eq!(listed.fonts.len(), 1);
        assert_eq!(listed.skipped_invalid, 0);
        let bytes = catalog.read(&listed.fonts[0].id).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(bytes.data)
                .unwrap(),
            fs::read(&path).unwrap()
        );
    }
    #[test]
    fn bundled_noto_face_reports_weight_axis() {
        let f = Fixture::new();
        f.font();
        let listed = FontCatalog::for_directories(vec![f.0.clone()])
            .list()
            .unwrap();
        assert_eq!(listed.fonts.len(), 1);
        let font = &listed.fonts[0];
        assert!(font.variable, "{font:?}");
        assert!(font
            .axes
            .iter()
            .any(|axis| axis.tag == "wght" && axis.min <= 200. && axis.max >= 700.));
        assert!((1..=1000).contains(&font.weight));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_roots_cover_usr_share_and_dejavu_styles() {
        let roots = system_roots().expect("linux font roots");
        assert!(roots.iter().any(|path| path == Path::new("/usr/share/fonts")));
        assert!(roots
            .iter()
            .any(|path| path == Path::new("/usr/local/share/fonts")));
        let dejavu = Path::new("/usr/share/fonts/truetype/dejavu");
        if !dejavu.join("DejaVuSans.ttf").is_file() {
            return;
        }
        let listed = FontCatalog::for_directories(vec![dejavu.to_path_buf()])
            .list()
            .unwrap();
        let regular = listed
            .fonts
            .iter()
            .find(|font| font.postscript == "DejaVuSans")
            .expect("DejaVu Sans");
        assert_eq!(regular.weight, 400);
        assert!(!regular.italic);
        assert!(!regular.variable);
        let bold = listed
            .fonts
            .iter()
            .find(|font| font.postscript == "DejaVuSans-Bold")
            .expect("DejaVu Sans Bold");
        assert_eq!(bold.weight, 700);
        assert!(listed.fonts.iter().any(|font| font.italic));
    }
}
