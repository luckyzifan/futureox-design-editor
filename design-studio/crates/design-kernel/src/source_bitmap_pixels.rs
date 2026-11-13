//! Read pixels only from the immutable bitmap directory granted by the
//! desktop host for this render. Layer data can name an asset, never a path.
use crate::{blend::Pixel, color::ColorSettings};
use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

const PREFIX: &str = "design-app://app/source-image/";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Directory {
    owner: String,
    directory: PathBuf,
}
/// One sequential read of an expanded bitmap that fits the existing 64 MiB
/// decoded-image budget. Larger photographs keep the two-line window.
const RESIDENT_RGBA_LIMIT: u64 = 64 * 1024 * 1024;
struct ResidentCache {
    order: VecDeque<PathBuf>,
    images: HashMap<PathBuf, Arc<[u8]>>,
    bytes: usize,
}
#[derive(Clone)]
pub(crate) struct Access {
    directory: Arc<Directory>,
    failed: Arc<AtomicBool>,
    resident: Arc<Mutex<ResidentCache>>,
}
impl Access {
    pub fn new(directory: Directory) -> Self {
        Self {
            directory: Arc::new(directory),
            failed: Arc::new(AtomicBool::new(false)),
            resident: Arc::new(Mutex::new(ResidentCache {
                order: VecDeque::new(),
                images: HashMap::new(),
                bytes: 0,
            })),
        }
    }
    pub fn check(&self) -> Result<(), String> {
        if self.failed.load(Ordering::Acquire) {
            Err("Sketch source pixels could not be read".into())
        } else {
            Ok(())
        }
    }
    pub fn resolve(&self, uri: &str) -> Result<Asset, String> {
        let (owner, filename) = uri
            .strip_prefix(PREFIX)
            .and_then(|v| v.split_once('/'))
            .ok_or("Invalid Sketch bitmap reference")?;
        if owner != self.directory.owner {
            return Err("Stale Sketch bitmap owner".into());
        }
        let (filename, rows) = filename
            .strip_suffix("?samples=1")
            .map_or((filename, false), |v| (v, true));
        let (hash, extent) = filename
            .strip_suffix(".png")
            .and_then(|v| v.split_once('-'))
            .ok_or("Invalid Sketch bitmap name")?;
        let (w, h) = extent
            .split_once('x')
            .ok_or("Invalid Sketch bitmap extent")?;
        if hash.len() != 64
            || !hash.bytes().all(|c| c.is_ascii_hexdigit())
            || ![w, h]
                .iter()
                .all(|s| s.len() <= 9 && !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err("Invalid Sketch bitmap name".into());
        }
        let width: u32 = w.parse().map_err(|_| "Invalid Sketch bitmap width")?;
        let height: u32 = h.parse().map_err(|_| "Invalid Sketch bitmap height")?;
        if width == 0 || height == 0 {
            return Err("Empty Sketch bitmap".into());
        }
        Ok(Asset {
            base: self.directory.directory.join(filename),
            width,
            height,
            rows,
            failed: self.failed.clone(),
            resident: self.resident.clone(),
        })
    }
}
pub(crate) fn is_source(uri: &str) -> bool {
    uri.starts_with(PREFIX)
}
pub(crate) struct Asset {
    base: PathBuf,
    width: u32,
    height: u32,
    rows: bool,
    failed: Arc<AtomicBool>,
    resident: Arc<Mutex<ResidentCache>>,
}
fn resident_rgba_len(width: u32, height: u32) -> Option<usize> {
    let bytes = u64::from(width).checked_mul(u64::from(height))?.checked_mul(4)?;
    if bytes == 0 || bytes > RESIDENT_RGBA_LIMIT {
        None
    } else {
        Some(bytes as usize)
    }
}
impl Asset {
    fn open(&self, path: &Path) -> Result<File, String> {
        if std::fs::symlink_metadata(path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Invalid source bitmap file".into());
        }
        let file = File::open(path).map_err(|e| e.to_string())?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("Invalid source bitmap file".into());
        }
        Ok(file)
    }
    pub fn png(&self) -> Result<Vec<u8>, String> {
        let file = self.open(&self.base)?;
        let limit = 64 * 1024 * 1024;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        if length > limit {
            return Err("Encoded Sketch image exceeds the conversion window".into());
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.take(length + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 != length
            || bytes.len() < 24
            || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
            || bytes[16..20] != self.width.to_be_bytes()
            || bytes[20..24] != self.height.to_be_bytes()
        {
            return Err("Sketch source image identity changed".into());
        }
        Ok(bytes)
    }
    pub fn raw(&self, settings: Option<ColorSettings>) -> Result<Option<Rows>, String> {
        if !self.rows {
            return Ok(None);
        }
        if self.width > 262144 {
            return Err("Sketch scanline exceeds the working set".into());
        }
        let path = self.base.with_extension("rgba");
        let bytes = resident_rgba_len(self.width, self.height);
        let store = if let Some(bytes) = bytes {
            Store::Resident(self.resident_rgba(&path, bytes)?)
        } else {
            let file = self.open(&path)?;
            if file.metadata().map_err(|e| e.to_string())?.len()
                != u64::from(self.width) * u64::from(self.height) * 4
            {
                return Err("Incomplete Sketch sample file".into());
            }
            Store::Stream {
                file,
                lines: std::array::from_fn(|_| (None, vec![0; self.width as usize * 4])),
            }
        };
        Ok(Some(Rows {
            width: self.width,
            height: self.height,
            managed: settings.is_some(),
            failed: self.failed.clone(),
            cache: RefCell::new(store),
        }))
    }
    /// Rotation samples source rows in an order the two-line window cannot
    /// hold. Read a budget-sized bitmap once and reuse it for later poses.
    fn resident_rgba(&self, path: &Path, bytes: usize) -> Result<Arc<[u8]>, String> {
        let cache = self.resident.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(hit) = cache.images.get(path) {
            return Ok(Arc::clone(hit));
        }
        drop(cache);
        let mut file = self.open(path)?;
        if file.metadata().map_err(|e| e.to_string())?.len() != bytes as u64 {
            return Err("Incomplete Sketch sample file".into());
        }
        let mut data = vec![0u8; bytes];
        file.read_exact(&mut data).map_err(|e| e.to_string())?;
        let data: Arc<[u8]> = Arc::from(data.into_boxed_slice());
        let mut cache = self.resident.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(hit) = cache.images.get(path) {
            return Ok(Arc::clone(hit));
        }
        while cache.bytes.saturating_add(bytes) > RESIDENT_RGBA_LIMIT as usize {
            let Some(old) = cache.order.pop_front() else { break };
            if let Some(removed) = cache.images.remove(&old) {
                cache.bytes = cache.bytes.saturating_sub(removed.len());
            }
        }
        if cache.bytes.saturating_add(bytes) <= RESIDENT_RGBA_LIMIT as usize {
            cache.bytes += bytes;
            cache.order.push_back(path.to_path_buf());
            cache.images.insert(path.to_path_buf(), Arc::clone(&data));
        }
        Ok(data)
    }
}
fn copy4(bytes: &[u8]) -> [u8; 4] {
    [bytes[0], bytes[1], bytes[2], bytes[3]]
}
enum Store {
    Stream { file: File, lines: [(Option<u32>, Vec<u8>); 2] },
    Resident(Arc<[u8]>),
}
pub(crate) struct Rows {
    pub width: u32,
    pub height: u32,
    managed: bool,
    failed: Arc<AtomicBool>,
    cache: RefCell<Store>,
}
impl Rows {
    pub fn at(&self, x: i32, y: i32) -> Pixel {
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return Pixel::default();
        }
        let y = y as u32;
        let failed = Arc::clone(&self.failed);
        let sample = {
            let mut store = self.cache.borrow_mut();
            let read = match &mut *store {
                Store::Resident(bytes) => {
                    let index = (y as usize * self.width as usize + x as usize) * 4;
                    Some(copy4(&bytes[index..index + 4]))
                }
                Store::Stream { file, lines } => {
                    let (number, line) = &mut lines[y as usize % 2];
                    if *number != Some(y) {
                        if file
                            .seek(SeekFrom::Start(u64::from(y) * u64::from(self.width) * 4))
                            .and_then(|_| file.read_exact(line))
                            .is_err()
                        {
                            failed.store(true, Ordering::Release);
                            None
                        } else {
                            *number = Some(y);
                            Some(copy4(&line[x as usize * 4..][..4]))
                        }
                    } else {
                        Some(copy4(&line[x as usize * 4..][..4]))
                    }
                }
            };
            match read {
                Some(bytes) => bytes,
                None => return Pixel::default(),
            }
        };
        self.pixel_from(&sample)
    }
    fn pixel_from(&self, p: &[u8]) -> Pixel {
        if self.managed {
            let [rgb, alpha] = crate::image_rows::srgb8_channels();
            Pixel::rgba(
                rgb[p[0] as usize],
                rgb[p[1] as usize],
                rgb[p[2] as usize],
                alpha[p[3] as usize],
            )
        } else {
            Pixel::rgba(
                p[0] as f32 / 255.,
                p[1] as f32 / 255.,
                p[2] as f32 / 255.,
                p[3] as f32 / 255.,
            )
            .rgba8_quantized()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rotated_samples_reuse_one_read_of_a_budget_sized_bitmap() {
        let root = std::env::temp_dir().join(format!("futureox-rotate-bitmap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let owner = "rotate1";
        let dir = root.join("bitmaps");
        fs::create_dir_all(&dir).unwrap();
        let hash = "ab".repeat(32);
        let (width, height) = (4u32, 3u32);
        let name = format!("{hash}-{width}x{height}");
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            pixel.copy_from_slice(&[index as u8, 20, 30, 255]);
        }
        let rgba = dir.join(format!("{name}.rgba"));
        fs::write(&rgba, &pixels).unwrap();
        let directory: Directory = serde_json::from_value(serde_json::json!({
            "owner": owner,
            "directory": dir,
        }))
        .unwrap();
        let access = Access::new(directory);
        let uri = format!("{PREFIX}{owner}/{name}.png?samples=1");
        let rows = access.resolve(&uri).unwrap().raw(None).unwrap().unwrap();
        fs::remove_file(&rgba).unwrap();
        // Column-major order is the rotation case: each step leaves the two-line window.
        for x in 0..width {
            for y in 0..height {
                let pixel = rows.at(x as i32, y as i32);
                let index = (y * width + x) as usize;
                assert_eq!(pixel.0[0], index as f32 / 255., "{x},{y}");
                assert_eq!(pixel.0[3], 1.);
            }
        }
        let again = access.resolve(&uri).unwrap().raw(None).unwrap().unwrap();
        assert_eq!(again.at(3, 2).0[0], pixels[11 * 4] as f32 / 255.);
        assert!(resident_rgba_len(4096, 4096).is_some());
        assert!(resident_rgba_len(8192, 8192).is_none());
        let _ = fs::remove_dir_all(&root);
    }
}
