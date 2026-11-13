//! Read pixels only from the immutable bitmap directory granted by the
//! desktop host for this render. Layer data can name an asset, never a path.
use crate::{blend::Pixel, color::ColorSettings};
use serde::Deserialize;
use std::{
    cell::{Cell, RefCell},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};

const PREFIX: &str = "design-app://app/source-image/";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Directory {
    owner: String,
    directory: PathBuf,
}
/// Bytes this access has actually allocated. `live_*` is what samplers hold
/// right now, including a read that has not finished. Peaks are the high
/// water of those sums. There is no image cache beside the sampler.
struct SampleTotals {
    row_reads: AtomicU64,
    bytes_read: AtomicU64,
    live_resident: AtomicUsize,
    peak_resident: AtomicUsize,
    live_in_flight: AtomicUsize,
    peak_in_flight: AtomicUsize,
    span_loads: AtomicU64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SampleAccounting {
    pub row_reads: u64,
    pub bytes_read: u64,
    pub live_resident: usize,
    pub peak_resident: usize,
    pub live_in_flight: usize,
    pub peak_in_flight: usize,
    pub span_loads: u64,
}
#[derive(Clone)]
pub(crate) struct Access {
    directory: Arc<Directory>,
    failed: Arc<AtomicBool>,
    totals: Arc<SampleTotals>,
}
impl Access {
    pub fn new(directory: Directory) -> Self {
        Self {
            directory: Arc::new(directory),
            failed: Arc::new(AtomicBool::new(false)),
            totals: Arc::new(SampleTotals {
                row_reads: AtomicU64::new(0),
                bytes_read: AtomicU64::new(0),
                live_resident: AtomicUsize::new(0),
                peak_resident: AtomicUsize::new(0),
                live_in_flight: AtomicUsize::new(0),
                peak_in_flight: AtomicUsize::new(0),
                span_loads: AtomicU64::new(0),
            }),
        }
    }
    pub(crate) fn sample_accounting(&self) -> SampleAccounting {
        let totals = &self.totals;
        SampleAccounting {
            row_reads: totals.row_reads.load(Ordering::Relaxed),
            bytes_read: totals.bytes_read.load(Ordering::Relaxed),
            live_resident: totals.live_resident.load(Ordering::Relaxed),
            peak_resident: totals.peak_resident.load(Ordering::Relaxed),
            live_in_flight: totals.live_in_flight.load(Ordering::Relaxed),
            peak_in_flight: totals.peak_in_flight.load(Ordering::Relaxed),
            span_loads: totals.span_loads.load(Ordering::Relaxed),
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
            totals: self.totals.clone(),
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
    totals: Arc<SampleTotals>,
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
        let rows = Rows {
            width: self.width,
            height: self.height,
            managed: settings.is_some(),
            failed: self.failed.clone(),
            totals: self.totals.clone(),
            local_resident: Cell::new(0),
            local_in_flight: Cell::new(0),
            cache: RefCell::new(Cache {
                file,
                lines: std::array::from_fn(|_| (None, vec![0; self.width as usize * 4])),
                span: None,
            }),
        };
        // The two scanlines are the sampler's own buffers, not an image cache.
        rows.set_resident(rows.line_bytes());
        Ok(Some(rows))
    }
}
/// One contiguous run of source rows owned by the sampler that asked for it.
/// Dropping the sampler drops the bytes. A later pose starts from the file.
struct Span {
    y0: u32,
    rows: u32,
    bytes: Vec<u8>,
}
struct Cache {
    file: File,
    lines: [(Option<u32>, Vec<u8>); 2],
    span: Option<Span>,
}
pub(crate) struct Rows {
    pub width: u32,
    pub height: u32,
    managed: bool,
    failed: Arc<AtomicBool>,
    totals: Arc<SampleTotals>,
    local_resident: Cell<usize>,
    local_in_flight: Cell<usize>,
    cache: RefCell<Cache>,
}
const ROTATION_SCRATCH_LIMIT: usize = 64 * 1024 * 1024;
fn charge(live: &AtomicUsize, peak: &AtomicUsize, local: &Cell<usize>, bytes: usize) {
    let old = local.get();
    local.set(bytes);
    let held = if bytes >= old {
        live.fetch_add(bytes - old, Ordering::AcqRel) + (bytes - old)
    } else {
        live.fetch_sub(old - bytes, Ordering::AcqRel) - (old - bytes)
    };
    peak.fetch_max(held, Ordering::Relaxed);
}
fn pixel_from(managed: bool, p: &[u8]) -> Pixel {
    if managed {
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
impl Rows {
    fn line_bytes(&self) -> usize {
        2 * self.width as usize * 4
    }
    fn set_resident(&self, bytes: usize) {
        charge(
            &self.totals.live_resident,
            &self.totals.peak_resident,
            &self.local_resident,
            bytes,
        );
    }
    fn set_in_flight(&self, bytes: usize) {
        charge(
            &self.totals.live_in_flight,
            &self.totals.peak_in_flight,
            &self.local_in_flight,
            bytes,
        );
    }
    /// Read `[y0, y1)` once into this sampler. The previous window is released
    /// before the new allocation, so the peak is one window plus the two
    /// scanlines. `y0 == y1` releases the window.
    pub(crate) fn cover_rows(&self, y0: u32, y1: u32) -> Result<(), String> {
        if y1 < y0 || y1 > self.height {
            return Err("Source row window is outside the image".into());
        }
        let line = self.line_bytes();
        if y0 == y1 {
            self.cache.borrow_mut().span = None;
            self.set_resident(line);
            return Ok(());
        }
        let count = (y1 - y0) as usize;
        let bytes = count
            .checked_mul(self.width as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or("Source row window overflows")?;
        if bytes > ROTATION_SCRATCH_LIMIT {
            return Err("Rotated source window exceeds the scratch budget".into());
        }
        {
            let mut cache = self.cache.borrow_mut();
            if let Some(span) = &cache.span {
                if span.y0 == y0 && span.rows == y1 - y0 {
                    return Ok(());
                }
            }
            cache.span = None;
        }
        self.set_resident(line);
        let mut data = Vec::new();
        data.try_reserve_exact(bytes)
            .map_err(|_| "Could not allocate rotated source window")?;
        data.resize(bytes, 0);
        // The buffer exists before the read finishes. Count it in both places.
        self.set_resident(line + bytes);
        self.set_in_flight(bytes);
        let read = {
            let mut cache = self.cache.borrow_mut();
            let file = &mut cache.file;
            file.seek(SeekFrom::Start(u64::from(y0) * u64::from(self.width) * 4))
                .and_then(|_| file.read_exact(&mut data))
        };
        self.set_in_flight(0);
        if read.is_err() {
            self.set_resident(line);
            self.failed.store(true, Ordering::Release);
            return Err("Sketch source pixels could not be read".into());
        }
        self.totals
            .row_reads
            .fetch_add(u64::from(y1 - y0), Ordering::Relaxed);
        self.totals
            .bytes_read
            .fetch_add(bytes as u64, Ordering::Relaxed);
        self.totals.span_loads.fetch_add(1, Ordering::Relaxed);
        self.cache.borrow_mut().span = Some(Span {
            y0,
            rows: y1 - y0,
            bytes: data,
        });
        Ok(())
    }
    pub fn at(&self, x: i32, y: i32) -> Pixel {
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return Pixel::default();
        }
        let y = y as u32;
        let mut cache = self.cache.borrow_mut();
        if let Some(span) = &cache.span {
            if y >= span.y0 && y < span.y0 + span.rows {
                let index = ((y - span.y0) as usize * self.width as usize + x as usize) * 4;
                let p = [
                    span.bytes[index],
                    span.bytes[index + 1],
                    span.bytes[index + 2],
                    span.bytes[index + 3],
                ];
                return pixel_from(self.managed, &p);
            }
        }
        let Cache {
            file,
            lines,
            span: _,
        } = &mut *cache;
        let (number, line) = &mut lines[y as usize % 2];
        if *number != Some(y) {
            let line_bytes = line.len();
            charge(
                &self.totals.live_in_flight,
                &self.totals.peak_in_flight,
                &self.local_in_flight,
                line_bytes,
            );
            let read = file
                .seek(SeekFrom::Start(u64::from(y) * u64::from(self.width) * 4))
                .and_then(|_| file.read_exact(line));
            charge(
                &self.totals.live_in_flight,
                &self.totals.peak_in_flight,
                &self.local_in_flight,
                0,
            );
            if read.is_err() {
                self.failed.store(true, Ordering::Release);
                return Pixel::default();
            }
            *number = Some(y);
            self.totals.row_reads.fetch_add(1, Ordering::Relaxed);
            self.totals
                .bytes_read
                .fetch_add(line_bytes as u64, Ordering::Relaxed);
        }
        let p = &line[x as usize * 4..][..4];
        pixel_from(self.managed, p)
    }
}
impl Drop for Rows {
    fn drop(&mut self) {
        self.set_resident(0);
        self.set_in_flight(0);
    }
}

#[cfg(test)]
mod pose_cost {
    use super::*;
    use std::time::Instant;

    fn pose_file(width: u32, height: u32) -> (std::path::PathBuf, String, Access) {
        let root =
            std::env::temp_dir().join(format!("futureox-rotate-pose-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("bitmaps");
        std::fs::create_dir_all(&dir).unwrap();
        let hash = "ab".repeat(32);
        let name = format!("{hash}-{width}x{height}");
        let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            let x = index % width as usize;
            let y = index / width as usize;
            pixel.copy_from_slice(&[(x * 13 + y * 3) as u8, (y * 5) as u8, 40, 255]);
        }
        std::fs::write(dir.join(format!("{name}.rgba")), &pixels).unwrap();
        let owner = "rotate-pose";
        let directory: Directory = serde_json::from_value(serde_json::json!({
            "owner": owner,
            "directory": dir,
        }))
        .unwrap();
        let access = Access::new(directory);
        let uri = format!("{PREFIX}{owner}/{name}.png?samples=1");
        (root, uri, access)
    }

    #[test]
    fn rotated_source_bitmap_reads_each_row_once() {
        let image_w = 4096u32;
        let image_h = 3072u32;
        let (root, uri, access) = pose_file(image_w, image_h);
        let covered = access.resolve(&uri).unwrap().raw(None).unwrap().unwrap();
        covered.cover_rows(0, image_h).unwrap();
        let streaming = access.resolve(&uri).unwrap().raw(None).unwrap().unwrap();
        for y in 0..image_h as i32 {
            for x in (0..image_w as i32).step_by(64) {
                assert_eq!(streaming.at(x, y).0, covered.at(x, y).0, "{x},{y}");
            }
        }
        drop(streaming);
        drop(covered);
        assert_eq!(access.sample_accounting().live_resident, 0);
        assert_eq!(access.sample_accounting().live_in_flight, 0);
        let node_w = 960.0f64;
        let node_h = 720.0f64;
        let degrees = 37.0f64;
        let (sin, cos) = degrees.to_radians().sin_cos();
        let cx = node_w / 2.;
        let cy = node_h / 2.;
        let wx = 700.0;
        let wy = 600.0;
        let transform = [
            cos,
            sin,
            -sin,
            cos,
            -cos * cx + sin * cy + wx,
            -sin * cx - cos * cy + wy,
        ];
        let mut doc = serde_json::json!({
            "schemaVersion": 4,
            "id": "d",
            "name": "rotate",
            "pages": [{"id": "p", "name": "Page", "children": ["image"], "background": "#ffffff"}],
            "nodes": {"image": {
                "id": "image",
                "kind": "rectangle",
                "width": node_w,
                "height": node_h,
                "transform": transform,
                "fills": [{"kind": "image", "image": uri, "color": "#ffffff", "fit": "stretch", "opacity": 1}]
            }}
        });
        let mut engine = crate::Engine::new();
        engine.set_source_bitmaps(Some(access.clone()));
        engine.load_document(&doc.to_string()).unwrap();
        let options: crate::RenderOptions = serde_json::from_value(serde_json::json!({
            "pageId": "p",
            "width": 1400,
            "height": 1200,
            "transparent": false,
            "grid": false,
            "view": {"x": 0, "y": 0, "zoom": 1},
            "rasterProfile": "analytic"
        }))
        .unwrap();
        let render_started = Instant::now();
        let frame = engine.render(&options).unwrap();
        let render_ms = render_started.elapsed().as_secs_f64() * 1000.;
        let mut colored = 0u32;
        let mut checksum = 0u64;
        for pixel in frame.chunks_exact(4) {
            checksum = checksum
                .wrapping_mul(16777619)
                .wrapping_add(u64::from(pixel[0]));
            if pixel[0] != 255 || pixel[1] != 255 || pixel[2] != 255 {
                colored += 1;
            }
        }
        let accounting = access.sample_accounting();
        eprintln!(
            "rotated render_ms={render_ms:.3} colored={colored} frame_checksum={checksum} accounting={accounting:?}"
        );
        // Pixel oracle from the two-line sampler on desktop-dev, same fixture,
        // before this windowed read: 693361 colored, checksum below, 1992 ms.
        assert_eq!(colored, 693361);
        assert_eq!(checksum, 11075008231204584046);
        assert!(accounting.span_loads >= 1);
        assert!(
            accounting.row_reads < 20_000,
            "row reads {}",
            accounting.row_reads
        );
        assert_eq!(accounting.live_resident, 0);
        assert_eq!(accounting.live_in_flight, 0);
        assert!(accounting.peak_in_flight > 0);
        assert!(accounting.peak_in_flight <= 64 * 1024 * 1024);
        assert!(accounting.peak_resident <= 64 * 1024 * 1024 + 2 * image_w as usize * 4);
        assert!(render_ms < 800., "rotated pose took {render_ms:.1} ms");
        let (sin, cos) = (-24.0f64).to_radians().sin_cos();
        doc["nodes"]["image"]["transform"] = serde_json::json!([
            cos,
            sin,
            -sin,
            cos,
            -cos * cx + sin * cy + wx,
            -sin * cx - cos * cy + wy,
        ]);
        let loads = access.sample_accounting().span_loads;
        engine.load_document(&doc.to_string()).unwrap();
        let again = Instant::now();
        let turned = engine.render(&options).unwrap();
        let again_ms = again.elapsed().as_secs_f64() * 1000.;
        let mut turned_sum = 0u64;
        for pixel in turned.chunks_exact(4) {
            turned_sum = turned_sum
                .wrapping_mul(16777619)
                .wrapping_add(u64::from(pixel[0]));
        }
        eprintln!("turned render_ms={again_ms:.3} frame_checksum={turned_sum}");
        assert_ne!(turned_sum, checksum);
        assert_eq!(access.sample_accounting().span_loads, loads + 1);
        assert!(again_ms < 800., "second angle took {again_ms:.1} ms");
        assert_eq!(access.sample_accounting().live_resident, 0);
        doc["nodes"]["image"]["transform"] = serde_json::json!([1, 0, 0, 1, 40, 30]);
        doc["nodes"]["image"]["width"] = serde_json::json!(320);
        doc["nodes"]["image"]["height"] = serde_json::json!(240);
        let before = access.sample_accounting();
        engine.load_document(&doc.to_string()).unwrap();
        let aligned_options: crate::RenderOptions = serde_json::from_value(serde_json::json!({
            "pageId": "p", "width": 400, "height": 300, "transparent": false, "grid": false,
            "view": {"x": 0, "y": 0, "zoom": 1}, "rasterProfile": "analytic"
        }))
        .unwrap();
        engine.render(&aligned_options).unwrap();
        let aligned = access.sample_accounting();
        assert_eq!(
            aligned.span_loads, before.span_loads,
            "axis-aligned paint must not read the whole image into a window"
        );
        assert!(aligned.row_reads - before.row_reads < 8_000);
        assert_eq!(aligned.live_resident, 0);
        let _ = std::fs::remove_dir_all(root);
    }
}
