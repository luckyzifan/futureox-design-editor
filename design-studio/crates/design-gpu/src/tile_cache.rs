//! Dirty-region tile cache over the native compositor.
//!
//! Every edit currently recomposites the whole viewport. This module splits
//! the output into fixed device-pixel tiles (matching the kernel's
//! [`futureox_design_kernel::tile_stack`] addressing), fingerprints the scene
//! inputs that can influence each tile, and re-composites only tiles whose
//! fingerprint changed. Unchanged tiles are replayed from cached presented
//! bytes, so the assembled frame is byte-identical to a full re-render.
//!
//! The fingerprint has two layers:
//!
//! * a **global key** — every input that affects all pixels at once (viewport
//!   transform, background, raster flags, colour management). A change here
//!   drops the whole cache: panning or zooming honestly pays a full repaint
//!   rather than faking a hit.
//! * a **per-tile key** — every node whose *influence rectangle* covers the
//!   tile, each contributing a SHA-256 of its serialized GPU command form
//!   plus the exact analytic curve segments it references (indices alone
//!   would alias when another node shifts the shared curve buffer).
//!
//! Influence rectangles start at each node's compiled working rect (which
//! already includes effect bleed and stroke margins) and are widened by two
//! rules before use:
//!
//! 1. A mask child's edits change its consumer's output across the consumer's
//!    whole rect (outside the mask, content is hidden) — the mask inherits the
//!    consumer's rect.
//! 2. Backdrop samplers (background blur, glass) read their capture region and
//!    emit across their own rect — any node overlapping a capture inherits the
//!    sampler's rect, covering both directions of the dependency.
//!
//! Dirty tiles are recomposited through the kernel's cropped compiler
//! (`compile_gpu_region`, command version 8), which preserves the camera and
//! composed matrices bit-for-bit. Anything this module cannot serve —
//! pixel-preview resampling, presentation crops, oversized viewports —
//! returns an error the caller answers with the ordinary full-frame path; it
//! never silently substitutes different pixels.
use crate::device::{NativeGpu, RenderedFrame, present_bytes};
use futureox_design_kernel::gpu::{GpuNode, GpuScene};
use futureox_design_kernel::math::Rect;
use futureox_design_kernel::tile_stack::TILE_SIZE;
use futureox_design_kernel::{Engine, RenderOptions};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

/// Cache upper bound: a viewport larger than this many tiles falls back to
/// the full-frame path instead of growing host memory without limit.
const MAX_CACHE_TILES: usize = 512;
/// Cached tile payloads keyed by device tile coordinate.
type TileFrames = HashMap<(i32, i32), (Vec<u8>, Option<Vec<f32>>)>;

type Key = [u8; 32];

struct CachedTile {
    key: Key,
    /// Presented RGBA8 bytes for the tile's on-screen rectangle.
    rgba: Vec<u8>,
    /// Presented linear samples for managed scenes.
    linear: Option<Vec<f32>>,
}

/// Counters for honest reporting: what was reused, what was repainted, and
/// what forced the slow path.
#[derive(Clone, Debug, Default, Serialize)]
pub struct TileCacheStats {
    pub tiles_total: usize,
    pub tiles_cached: usize,
    pub tiles_rendered: usize,
    /// Full-frame compositions: cold cache or global-key invalidation.
    pub full_frames: usize,
    /// SHA-256 fingerprinting + influence computation time.
    pub key_ms: f64,
    /// Scene compile time (full scene plus per-tile crops).
    pub compile_ms: f64,
    /// Whole render call, including assembly.
    pub render_ms: f64,
    pub cache_bytes: usize,
}

pub struct TileCache {
    entries: HashMap<(i32, i32), CachedTile>,
    global_key: Option<Key>,
    pub stats: TileCacheStats,
}

/// One visible device tile: grid address plus its on-screen rectangle
/// (partial at the right/bottom viewport edges).
#[derive(Clone, Copy)]
struct Tile {
    col: i32,
    row: i32,
    rect: Rect,
}

fn tiles_for(width: u32, height: u32) -> Vec<Tile> {
    let side = TILE_SIZE as u32;
    let mut tiles = Vec::new();
    let mut row = 0;
    let mut y = 0;
    while y < height {
        let mut col = 0;
        let mut x = 0;
        while x < width {
            let w = side.min(width - x);
            let h = side.min(height - y);
            tiles.push(Tile {
                col,
                row,
                rect: Rect::new(x as i32, y as i32, w, h),
            });
            x += side;
            col += 1;
        }
        y += side;
        row += 1;
    }
    tiles
}

fn digest(parts: &[&[u8]]) -> Key {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn f64_key(v: f64) -> [u8; 8] {
    v.to_bits().to_le_bytes()
}

/// Everything that can change every pixel at once. The viewport transform is
/// compared bit-exactly so a camera nudge never borrows stale tiles.
fn global_key(scene: &GpuScene) -> Result<Key, String> {
    let managed = scene
        .color_management
        .as_ref()
        .map(|settings| serde_json::to_string(settings).map_err(|e| e.to_string()))
        .transpose()?;
    let color: &[u8] = managed.as_deref().map_or(b"none", |s| s.as_bytes());
    Ok(digest(&[
        b"global-v1",
        &scene.width.to_le_bytes(),
        &scene.height.to_le_bytes(),
        &scene.extent.x.to_le_bytes(),
        &scene.extent.y.to_le_bytes(),
        &scene.extent.w.to_le_bytes(),
        &scene.extent.h.to_le_bytes(),
        &f64_key(scene.view.x),
        &f64_key(scene.view.y),
        &f64_key(scene.view.zoom),
        scene.background.as_bytes(),
        &[u8::from(scene.transparent), u8::from(scene.grid)],
        &[
            u8::from(scene.float_compositing),
            u8::from(scene.coherent_samples),
            u8::from(scene.backdrop_samples),
            u8::from(scene.integrated_blur),
            u8::from(scene.software_raster),
        ],
        color,
    ]))
}

/// Capture region of a backdrop-sampling node: its own rect union the
/// `backdrop_box` neighbourhood it reads.
fn capture_rect(n: &GpuNode) -> Rect {
    let base = n.rect;
    if futureox_design_kernel::scene::selected_backdrop(&n.effects).is_none() {
        return base;
    }
    let (x, y, w, h) = (
        n.backdrop_box[0].floor() as i32,
        n.backdrop_box[1].floor() as i32,
        n.backdrop_box[2].ceil().max(0.) as i32,
        n.backdrop_box[3].ceil().max(0.) as i32,
    );
    base.union(Rect::new(x, y, w as u32, h as u32))
}

fn curve_slice(scene: &GpuScene, first: u32, count: u32) -> &[f32] {
    let start = first as usize;
    let end = start.saturating_add(count as usize);
    if start <= end && end <= scene.curves.len() {
        &scene.curves[start..end]
    } else {
        &[]
    }
}

fn curves_bits(scene: &GpuScene, n: &GpuNode) -> Vec<u8> {
    let mut bits = Vec::new();
    let mut push = |first: u32, count: u32| {
        for value in curve_slice(scene, first, count) {
            bits.extend_from_slice(&value.to_bits().to_le_bytes());
        }
    };
    if let Some(area) = &n.fill.area {
        push(area.first, area.count);
    }
    if let Some(analytic) = &n.fill.analytic {
        push(analytic.first, analytic.count);
    }
    for stroke in &n.strokes {
        if let Some(area) = &stroke.path.area {
            push(area.first, area.count);
        }
        if let Some(analytic) = &stroke.path.analytic {
            push(analytic.first, analytic.count);
        }
    }
    bits
}

/// Per-node content fingerprint: the serialized GPU command node plus the
/// exact analytic curve segments it references.
fn node_key(scene: &GpuScene, n: &GpuNode) -> Result<Key, String> {
    let json = serde_json::to_string(n).map_err(|e| e.to_string())?;
    let curves = curves_bits(scene, n);
    Ok(digest(&[json.as_bytes(), &curves]))
}

/// Influence rectangle per node: where edits to this node can change pixels.
/// Starts at the compiled working rect; see the module docs for the mask and
/// backdrop widening rules.
fn influence_rects(scene: &GpuScene) -> BTreeMap<&str, Rect> {
    let mut rects: BTreeMap<&str, Rect> = scene
        .nodes
        .iter()
        .map(|(id, node)| (id.as_str(), node.rect))
        .collect();
    // Masks consume their group's content: editing the mask changes the
    // group output across the whole consumer rect.
    for node in scene.nodes.values() {
        if let Some(mask) = &node.mask_id
            && let Some(consumer) = rects.get_mut(mask.as_str())
        {
            *consumer = consumer.union(node.rect);
        }
    }
    // Backdrop samplers read their capture region and emit across their own
    // rect, so content overlapping a capture inherits the sampler's rect.
    let samplers: Vec<(&str, Rect)> = scene
        .nodes
        .iter()
        .filter(|(_, n)| futureox_design_kernel::scene::selected_backdrop(&n.effects).is_some())
        .map(|(id, n)| (id.as_str(), capture_rect(n)))
        .collect();
    if !samplers.is_empty() {
        for (id, node) in &scene.nodes {
            for (sampler_id, capture) in &samplers {
                if *sampler_id != id.as_str()
                    && !node.rect.intersect(*capture).empty()
                    && let Some(rect) = rects.get_mut(id.as_str())
                    && let Some(sampler) = scene.nodes.get(*sampler_id)
                {
                    *rect = rect.union(sampler.rect);
                }
            }
        }
    }
    rects
}

/// Nodes influencing a device rect, sorted for deterministic hashing.
fn influencers<'a>(influence: &BTreeMap<&'a str, Rect>, rect: Rect) -> Vec<&'a str> {
    influence
        .iter()
        .filter(|(_, r)| !r.intersect(rect).empty())
        .map(|(id, _)| *id)
        .collect()
}

fn tile_key(
    global: &Key,
    influence: &BTreeMap<&str, Rect>,
    node_keys: &BTreeMap<&str, Key>,
    tile: Tile,
) -> Key {
    let mut hasher = Sha256::new();
    hasher.update(b"tile-v1");
    hasher.update(global);
    hasher.update(tile.col.to_le_bytes());
    hasher.update(tile.row.to_le_bytes());
    hasher.update(tile.rect.w.to_le_bytes());
    hasher.update(tile.rect.h.to_le_bytes());
    for id in influencers(influence, tile.rect) {
        hasher.update(id.as_bytes());
        if let Some(key) = node_keys.get(id) {
            hasher.update(key);
        }
    }
    hasher.finalize().into()
}

/// Split a presented full-frame buffer into per-tile cache entries.
fn split_frame(
    tiles: &[Tile],
    keys: &HashMap<(i32, i32), Key>,
    width: u32,
    rgba: &[u8],
    linear: Option<&[f32]>,
) -> HashMap<(i32, i32), CachedTile> {
    let mut entries = HashMap::with_capacity(tiles.len());
    for tile in tiles {
        let mut tile_rgba = Vec::with_capacity(tile.rect.pixels() * 4);
        let mut tile_linear = linear.map(|_| Vec::with_capacity(tile.rect.pixels() * 4));
        for row in 0..tile.rect.h as usize {
            let src = ((tile.rect.y as usize + row) * width as usize + tile.rect.x as usize) * 4;
            tile_rgba.extend_from_slice(&rgba[src..src + tile.rect.w as usize * 4]);
            if let (Some(values), Some(out)) = (linear, tile_linear.as_mut()) {
                out.extend_from_slice(&values[src..src + tile.rect.w as usize * 4]);
            }
        }
        entries.insert(
            (tile.col, tile.row),
            CachedTile {
                key: *keys
                    .get(&(tile.col, tile.row))
                    .expect("key computed for every tile"),
                rgba: tile_rgba,
                linear: tile_linear,
            },
        );
    }
    entries
}

#[derive(Default)]
struct FrameTotals {
    draw_calls: usize,
    submissions: usize,
    peak_bytes: u64,
    encode_ms: f64,
    readback_ms: f64,
}

impl TileCache {
    pub fn new() -> Self {
        TileCache {
            entries: HashMap::new(),
            global_key: None,
            stats: TileCacheStats::default(),
        }
    }

    /// Drop all cached tiles (for example when the GPU device is lost).
    pub fn clear(&mut self) {
        self.entries.clear();
        self.global_key = None;
    }

    /// Render `options` through the tile cache. On any condition this module
    /// cannot serve exactly — pixel preview, presentation crops, oversized
    /// viewports — returns `Err` and the caller must run the ordinary
    /// full-frame [`NativeGpu::render`].
    pub fn render(
        &mut self,
        gpu: &mut NativeGpu,
        engine: &mut Engine,
        options: &RenderOptions,
    ) -> Result<RenderedFrame, String> {
        let started = Instant::now();
        self.stats = TileCacheStats::default();
        if options.pixel_preview.is_some() {
            return Err("Pixel preview resamples a presentation frame".into());
        }
        let tiles = tiles_for(options.width, options.height);
        if tiles.is_empty() || tiles.len() > MAX_CACHE_TILES {
            return Err("Viewport tile count outside cache budget".into());
        }
        self.stats.tiles_total = tiles.len();

        let compile_started = Instant::now();
        let scene = engine.compile_gpu(options)?;
        if scene.presentation.is_some() || scene.resolve.is_some() {
            return Err(
                "Scene presents a resampled crop; tile cache needs a direct viewport".into(),
            );
        }
        let global = global_key(&scene)?;
        let node_keys: BTreeMap<&str, Key> = scene
            .nodes
            .iter()
            .map(|(id, node)| node_key(&scene, node).map(|key| (id.as_str(), key)))
            .collect::<Result<_, _>>()?;
        self.stats.compile_ms += compile_started.elapsed().as_secs_f64() * 1000.;

        let key_started = Instant::now();
        if self.global_key.as_ref() != Some(&global) {
            // Viewport transform or raster settings moved: every tile is
            // stale. Counted as a full frame below, when all tiles re-compose.
            self.entries.clear();
            self.global_key = Some(global);
        }
        let influence = influence_rects(&scene);
        let keyed: Vec<(Tile, Key)> = tiles
            .iter()
            .map(|tile| (*tile, tile_key(&global, &influence, &node_keys, *tile)))
            .collect();
        self.stats.key_ms = key_started.elapsed().as_secs_f64() * 1000.;

        let dirty: Vec<(Tile, Key)> = keyed
            .into_iter()
            .filter(|(tile, key)| {
                self.entries
                    .get(&(tile.col, tile.row))
                    .is_none_or(|entry| entry.key != *key)
            })
            .collect();
        self.stats.tiles_cached = tiles.len() - dirty.len();

        let mut totals = FrameTotals::default();
        let frame_rect = Rect::new(0, 0, options.width, options.height);
        let mut fresh: TileFrames = HashMap::new();

        let (rgba, linear) = if dirty.len() == tiles.len() {
            // Cold or globally invalidated frame: one full composition also
            // seeds every cache slot; bytes equal the ordinary path because
            // they ARE the ordinary path.
            self.stats.full_frames += 1;
            self.stats.tiles_rendered = tiles.len();
            let raw = self.compose_and_read(gpu, &scene, frame_rect, &mut totals)?;
            present_bytes(
                raw,
                scene.float_compositing,
                scene.color_management,
                scene.software_raster,
                false,
            )?
        } else {
            // Partial frame: re-compose dirty tiles through cropped command
            // scenes, then stitch with the cached presented bytes.
            self.stats.tiles_rendered = dirty.len();
            // One prepare guard shared by every dirty tile: the engine caches
            // the flattened-geometry phase per camera for this union.
            let prepare = (!dirty.is_empty())
                .then(|| dirty.iter().fold(dirty[0].0.rect, |acc, (tile, _)| acc.union(tile.rect)));
            for (tile, _) in &dirty {
                let compile_started = Instant::now();
                let tile_scene = engine.compile_gpu_region(options, tile.rect, prepare)?;
                self.stats.compile_ms += compile_started.elapsed().as_secs_f64() * 1000.;
                let raw = self.compose_and_read(gpu, &tile_scene, tile.rect, &mut totals)?;
                let presented = present_bytes(
                    raw,
                    tile_scene.float_compositing,
                    tile_scene.color_management,
                    tile_scene.software_raster,
                    false,
                )?;
                fresh.insert((tile.col, tile.row), presented);
            }
            let assembled = self.assemble(&tiles, options.width, options.height, &fresh);
            // Persist the freshly presented bytes under their new keys so the
            // next frame can replay them.
            for (tile, key) in &dirty {
                if let Some((rgba, linear)) = fresh.remove(&(tile.col, tile.row)) {
                    self.entries.insert(
                        (tile.col, tile.row),
                        CachedTile {
                            key: *key,
                            rgba,
                            linear,
                        },
                    );
                }
            }
            assembled
        };

        if dirty.len() == tiles.len() {
            let keys: HashMap<(i32, i32), Key> = dirty
                .iter()
                .map(|(tile, key)| ((tile.col, tile.row), *key))
                .collect();
            self.entries = split_frame(&tiles, &keys, options.width, &rgba, linear.as_deref());
        }
        self.stats.cache_bytes = self
            .entries
            .values()
            .map(|e| e.rgba.len() + e.linear.as_ref().map_or(0, |v| v.len() * 4))
            .sum();
        self.stats.render_ms = started.elapsed().as_secs_f64() * 1000.;
        Ok(RenderedFrame {
            width: options.width,
            height: options.height,
            rgba,
            linear,
            draw_calls: totals.draw_calls,
            submissions: totals.submissions,
            peak_texture_bytes: totals.peak_bytes,
            render_ms: started.elapsed().as_secs_f64() * 1000.,
            encode_ms: totals.encode_ms,
            readback_ms: totals.readback_ms,
        })
    }

    /// Compose a scene and read one absolute device rectangle out of it.
    fn compose_and_read(
        &mut self,
        gpu: &mut NativeGpu,
        scene: &GpuScene,
        region: Rect,
        totals: &mut FrameTotals,
    ) -> Result<Vec<u8>, String> {
        let render_started = Instant::now();
        let (mut frame, output, _, _) = gpu.compose(scene)?;
        let encode_ms = render_started.elapsed().as_secs_f64() * 1000.;
        let wait_started = Instant::now();
        let raw = frame.read_surface_rect(output, region);
        let stats = frame.stats();
        drop(frame);
        let raw = raw?;
        gpu.check_public_errors()?;
        totals.draw_calls += stats.draw_calls;
        totals.submissions += stats.submissions;
        totals.peak_bytes = totals.peak_bytes.max(stats.peak_texture_bytes);
        totals.encode_ms += encode_ms;
        totals.readback_ms += wait_started.elapsed().as_secs_f64() * 1000.;
        Ok(raw)
    }

    /// Stitch cached and freshly presented tiles into frame buffers.
    fn assemble(
        &self,
        tiles: &[Tile],
        width: u32,
        height: u32,
        fresh: &TileFrames,
    ) -> (Vec<u8>, Option<Vec<f32>>) {
        let managed = fresh.values().any(|(_, linear)| linear.is_some());
        let mut rgba = vec![0u8; width as usize * height as usize * 4];
        let mut linear = managed.then(|| vec![0f32; width as usize * height as usize * 4]);
        for tile in tiles {
            let address = (tile.col, tile.row);
            let (bytes, values) = match fresh.get(&address) {
                Some(presented) => (presented.0.as_slice(), presented.1.as_deref()),
                None => {
                    let entry = self
                        .entries
                        .get(&address)
                        .expect("tile either fresh or cached");
                    (entry.rgba.as_slice(), entry.linear.as_deref())
                }
            };
            for row in 0..tile.rect.h as usize {
                let src = row * tile.rect.w as usize * 4;
                let dst =
                    ((tile.rect.y as usize + row) * width as usize + tile.rect.x as usize) * 4;
                rgba[dst..dst + tile.rect.w as usize * 4]
                    .copy_from_slice(&bytes[src..src + tile.rect.w as usize * 4]);
                if let Some(out) = linear.as_mut() {
                    let values = values.expect("managed frames keep linear bytes per tile");
                    out[dst..dst + tile.rect.w as usize * 4]
                        .copy_from_slice(&values[src..src + tile.rect.w as usize * 4]);
                }
            }
        }
        (rgba, linear)
    }
}

impl Default for TileCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Influence computation exposed for tests and diagnostics.
pub fn tile_influence(scene: &GpuScene, tile: Rect) -> Vec<String> {
    let influence = influence_rects(scene);
    influencers(&influence, tile)
        .into_iter()
        .map(str::to_owned)
        .collect()
}
