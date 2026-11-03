//! Optional, content-addressed display data. It contains no paths, source
//! locators or edit authority. A damaged or obsolete entry is a cold open.
use super::super::{
    canvas_layout::{Box2, Item},
    digest,
};
use super::{State, catalog::Catalog};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};
const LIMIT: u64 = 32 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"FXTHMB01";
static POLICY: OnceLock<Option<String>> = OnceLock::new();
#[derive(Serialize, Deserialize)]
pub(super) struct Saved {
    key: String,
    bounds: Box2,
    pages: Vec<(String, String, usize)>,
    items: Vec<Item>,
    images: Vec<(usize, String)>,
}
pub(super) fn location(root: &Path, source: &str) -> Option<PathBuf> {
    if source.len() != 64 || !source.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let policy = POLICY
        .get_or_init(|| {
            let exe = std::env::current_exe().ok()?;
            let font = exe.parent()?.parent()?.join("fonts/NotoSansSC.ttf");
            let a = digest(&fs::read(exe).ok()?);
            let b = digest(&fs::read(font).ok()?);
            Some(digest(format!("opening-v1/{a}/{b}").as_bytes()))
        })
        .as_ref()?;
    Some(root.join("opening-thumbnails").join(format!(
        "{}.thumb",
        digest(format!("{source}/{policy}").as_bytes())
    )))
}
pub(super) fn read(path: &Path) -> Option<(Catalog, Vec<(usize, String)>)> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > LIMIT || meta.len() < 72 {
        return None;
    }
    let mut b = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(LIMIT + 1)
        .read_to_end(&mut b)
        .ok()?;
    if b.len() as u64 != meta.len()
        || b.get(..8)? != MAGIC
        || digest(&b[72..]).as_bytes() != &b[8..72]
    {
        return None;
    }
    let s: Saved = serde_json::from_slice(&b[72..]).ok()?;
    if s.key != path.file_stem()?.to_str()? {
        return None;
    }
    let n = s.items.len();
    if n > 16_384
        || s.pages.len() > 512
        || s.images.len() > n
        || s.pages
            .iter()
            .try_fold(0usize, |sum, p| sum.checked_add(p.2))?
            != n
    {
        return None;
    }
    let mut seen = vec![false; n];
    for (i, png) in &s.images {
        if *i >= n || seen[*i] || png.len() > 64 * 1024 {
            return None;
        }
        let head = base64::engine::general_purpose::STANDARD
            .decode(png.as_bytes().get(..32)?)
            .ok()?;
        if head.get(..8)? != b"\x89PNG\r\n\x1a\n"
            || head.get(12..16)? != b"IHDR"
            || !(1..=96).contains(&u32::from_be_bytes(head.get(16..20)?.try_into().ok()?))
            || !(1..=96).contains(&u32::from_be_bytes(head.get(20..24)?.try_into().ok()?))
        {
            return None;
        }
        seen[*i] = true
    }
    Some((
        Catalog {
            items: s.items,
            roots: vec![],
            pages: s.pages,
            bounds: s.bounds,
        },
        s.images,
    ))
}
pub(super) fn snapshot(path: &Path, state: &State) -> Option<Saved> {
    let c = state.catalog.as_ref()?;
    if state.images.is_empty() && !c.items.is_empty() {
        return None;
    }
    Some(Saved {
        key: path.file_stem()?.to_str()?.into(),
        bounds: c.bounds,
        pages: c.pages.clone(),
        items: c.items.clone(),
        images: state.images.clone(),
    })
}
pub(super) fn write(path: &Path, mut saved: Saved) -> Option<()> {
    let dir = path.parent()?;
    fs::create_dir_all(dir).ok()?;
    if !fs::symlink_metadata(dir).ok()?.is_dir() {
        return None;
    }
    // Merge independently viewed pages. A partial writer must not replace a
    // complete cache produced by another window for the very same file.
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(".writer"))
        .ok()?;
    fs2::FileExt::try_lock_exclusive(&lock).ok()?;
    if let Some((_, existing)) = read(path) {
        let mut have: std::collections::HashSet<_> = saved.images.iter().map(|v| v.0).collect();
        for entry in existing {
            if have.insert(entry.0) {
                saved.images.push(entry)
            }
        }
    }
    let payload = serde_json::to_vec(&saved).ok()?;
    if payload.len() as u64 + 72 > LIMIT {
        return None;
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .ok()?;
        f.write_all(MAGIC).ok()?;
        f.write_all(digest(&payload).as_bytes()).ok()?;
        f.write_all(&payload).ok()?;
        f.flush().ok()?;
        drop(f);
        fs::rename(&tmp, path).ok()?;
        Some(())
    })();
    if result.is_none() {
        let _ = fs::remove_file(tmp);
    }
    // Bound disposable storage without involving canonical checkpoints or user files.
    let mut files = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let p = e.path();
            let stem = p.file_stem()?.to_str()?;
            let m = fs::symlink_metadata(&p).ok()?;
            (m.is_file()
                && p.extension()? == "thumb"
                && stem.len() == 64
                && stem.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| (m.modified().ok(), m.len(), p))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|a| a.0);
    let mut bytes: u64 = files.iter().map(|v| v.1).sum();
    let mut count = files.len();
    for (_, size, p) in files {
        if bytes <= 64 * 1024 * 1024 && count <= 8 {
            break;
        }
        if p != path && fs::remove_file(p).is_ok() {
            bytes = bytes.saturating_sub(size);
            count -= 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independently_viewed_materials_merge_and_corrupt_or_foreign_receipts_are_ignored() {
        let dir = std::env::temp_dir().join(format!(
            "opening-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let key = "a".repeat(64);
        let path = dir.join(format!("{key}.thumb"));
        let bounds = Box2 {
            x: 0.,
            y: 0.,
            width: 100.,
            height: 100.,
        };
        let item = |id: &str| Item {
            key: id.into(),
            id: id.into(),
            name: id.into(),
            kind: "artboard".into(),
            page_id: "p".into(),
            page_name: "Page".into(),
            source: bounds,
            placed: bounds,
            bytes: 10,
        };
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBApWZmgAAAABJRU5ErkJggg==";
        let saved = |i| Saved {
            key: key.clone(),
            bounds,
            pages: vec![("p".into(), "Page".into(), 2)],
            items: vec![item("a"), item("b")],
            images: vec![(i, png.into())],
        };
        write(&path, saved(1)).unwrap();
        assert_eq!(read(&path).unwrap().1.len(), 1);
        write(&path, saved(0)).unwrap();
        let (_, mut images) = read(&path).unwrap();
        images.sort();
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].0, 0);
        let other = dir.join(format!("{}.thumb", "b".repeat(64)));
        fs::copy(&path, &other).unwrap();
        assert!(read(&other).is_none());
        let mut bytes = fs::read(&path).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(read(&path).is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}
