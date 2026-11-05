//! Read pixels only from the immutable bitmap directory granted by the
//! desktop host for this render. Layer data can name an asset, never a path.
use crate::{blend::Pixel, color::ColorSettings};
use serde::Deserialize;
use std::{
    cell::RefCell,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc,
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
#[derive(Clone)]
pub(crate) struct Access {
    directory: Arc<Directory>,
    failed: Arc<AtomicBool>,
}
impl Access {
    pub fn new(directory: Directory) -> Self {
        Self {
            directory: Arc::new(directory),
            failed: Arc::new(AtomicBool::new(false)),
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
        let file = self.open(&self.base.with_extension("rgba"))?;
        if file.metadata().map_err(|e| e.to_string())?.len()
            != u64::from(self.width) * u64::from(self.height) * 4
        {
            return Err("Incomplete Sketch sample file".into());
        }
        Ok(Some(Rows {
            width: self.width,
            height: self.height,
            managed: settings.is_some(),
            failed: self.failed.clone(),
            cache: RefCell::new(Cache {
                file,
                lines: std::array::from_fn(|_| (None, vec![0; self.width as usize * 4])),
            }),
        }))
    }
}
struct Cache {
    file: File,
    lines: [(Option<u32>, Vec<u8>); 2],
}
pub(crate) struct Rows {
    pub width: u32,
    pub height: u32,
    managed: bool,
    failed: Arc<AtomicBool>,
    cache: RefCell<Cache>,
}
impl Rows {
    pub fn at(&self, x: i32, y: i32) -> Pixel {
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return Pixel::default();
        }
        let y = y as u32;
        let mut cache = self.cache.borrow_mut();
        let Cache { file, lines } = &mut *cache;
        let (number, line) = &mut lines[y as usize % 2];
        if *number != Some(y) {
            if file
                .seek(SeekFrom::Start(u64::from(y) * u64::from(self.width) * 4))
                .and_then(|_| file.read_exact(line))
                .is_err()
            {
                self.failed.store(true, Ordering::Release);
                return Pixel::default();
            }
            *number = Some(y);
        }
        let p = &line[x as usize * 4..][..4];
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
