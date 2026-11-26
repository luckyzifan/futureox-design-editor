//! Bounded, read-only host font discovery for non-embedded Sketch source
//! faces. Nothing here enters the document font table: the host machine's
//! installed font files stay runtime-only inputs to text shaping, exactly like
//! the authored Sketch source names they substitute for.
//!
//! Indices store file names and paths only. A file is opened only when its
//! name is a candidate for a requested source face; commercial fonts are never
//! copied into the repository, the package, a saved document or an export.
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::OnceLock,
};

const MAX_ENTRIES: usize = 4096;
const MAX_FONTS: usize = 1024;
const MAX_DEPTH: usize = 4;
/// Filename matching is intentionally conservative. A renamed font is still
/// found through its name table once its file name is a candidate; an
/// exhaustive scan of every installed font is not performed on document load.
const MAX_CANDIDATES_PER_NAME: usize = 8;

pub(super) fn compact_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-' | '\u{00a0}'))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

pub(super) struct IndexedFont {
    pub path: PathBuf,
    pub stem: String,
}

pub(super) struct Index {
    fonts: Vec<IndexedFont>,
}

impl Index {
    /// Source names are matched against the compacted file stem. Exact,
    /// contained and containing names are candidates; the installed bytes are
    /// then verified against the face's real family, style and PostScript
    /// names, so a look-alike file cannot silently become the requested face.
    pub(super) fn candidates(&self, names: &BTreeSet<String>) -> Vec<(String, PathBuf)> {
        let mut output = Vec::new();
        for name in names {
            let key = compact_name(name);
            if key.chars().count() < 4 {
                continue;
            }
            let mut found = Vec::new();
            for font in &self.fonts {
                let stem = font.stem.as_str();
                if stem.len() >= 4 && (stem == key || stem.contains(&key) || key.contains(stem)) {
                    found.push(font.path.clone());
                }
            }
            found.sort();
            found.dedup();
            found.truncate(MAX_CANDIDATES_PER_NAME);
            output.extend(found.into_iter().map(|path| (name.clone(), path)));
        }
        output.sort();
        output
    }
}

/// Fixed per-platform font roots. The kernel never accepts a caller-supplied
/// directory: this is a runtime fallback for locally installed faces, not a
/// file-read API.
pub(super) fn system_roots() -> Vec<PathBuf> {
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
    roots
}

fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "ttf" | "otf" | "ttc" | "otc"
            )
        })
}

pub(super) fn index(roots: &[PathBuf]) -> Index {
    let mut fonts = Vec::new();
    let mut stack = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut canonical_roots = Vec::new();
    for root in roots {
        let Ok(root) = root.canonicalize() else { continue };
        if !root.is_dir() || !seen.insert(root.clone()) {
            continue;
        }
        canonical_roots.push(root.clone());
        stack.push((root, 0usize));
    }
    stack.reverse();
    let mut entries = 0usize;
    let mut seen_files = std::collections::HashSet::new();
    'scan: while let Some((directory, depth)) = stack.pop() {
        let Ok(listing) = std::fs::read_dir(&directory) else { continue };
        for item in listing {
            if entries >= MAX_ENTRIES || fonts.len() >= MAX_FONTS {
                break 'scan;
            }
            entries += 1;
            let Ok(item) = item else { continue };
            let path = item.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else { continue };
            let Ok(canonical) = path.canonicalize() else { continue };
            if metadata.file_type().is_symlink() {
                // A link must resolve to a regular file inside a trusted root.
                if !canonical.is_file()
                    || !canonical_roots
                        .iter()
                        .any(|root| canonical.starts_with(root))
                {
                    continue;
                }
            } else if canonical != path {
                continue;
            }
            if metadata.is_dir() {
                if depth < MAX_DEPTH && seen.insert(path.clone()) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !is_font_file(&path) || !seen_files.insert(canonical.clone()) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let stem = compact_name(stem);
            if stem.is_empty() {
                continue;
            }
            fonts.push(IndexedFont { path: canonical, stem });
        }
    }
    fonts.sort_by(|a, b| a.path.cmp(&b.path));
    Index { fonts }
}

/// Process-wide host font index. Building it only reads directory entries, so
/// repeated document loads and forked preparation lanes do not rescan bytes.
pub(super) fn system() -> &'static Index {
    static INDEX: OnceLock<Index> = OnceLock::new();
    INDEX.get_or_init(|| index(&system_roots()))
}