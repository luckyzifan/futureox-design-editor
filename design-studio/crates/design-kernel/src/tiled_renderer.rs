//! Tiled rendering: plan visible addresses, rasterize invalid tiles, then
//! compose completed levels. Surface pools, cache ownership and telemetry stay
//! with the renderer; host code supplies scheduling and frame deadlines.

use crate::raster_surface::RasterSurfacePool;
use crate::render_instruction::{render_trait, RenderInstruction, WorldRect};
use crate::render_telemetry::RenderingTelemetry;
use crate::renderer::{RenderOptions, View};
use crate::tile_level::{TileMipLevel, LEVEL_TILE_LIMIT};
use crate::tile_stack::TILE_SIZE;
use std::sync::Arc;
use std::collections::HashMap;
/// Freshly rasterised tiles: address plus premultiplied RGBA8 bytes.
type RasterisedTiles = Vec<([i32; 2], Vec<u8>)>;

pub const CORE_TEXT_RENDERING: bool = true;
pub const GPU_OVERLAY: bool = false;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderFeatureFlags {
    /// `rasterizeConcurrently` — tile rasterisation may run on worker
    /// threads. Off by default: single-threaded hosts (wasm) keep the
    /// calling-thread path; native desktops opt in.
    pub rasterize_concurrently: bool,
    /// `singleThreadedContentRendering` — force the calling thread even when
    /// concurrent rasterisation is enabled (diagnostics, byte-for-byte
    /// comparison against the parallel path).
    pub single_threaded_content_rendering: bool,
    /// Upper bound on rasterisation workers. `None` picks a platform default
    /// (capped) so CPU-intensive work never spawns unbounded threads.
    pub worker_limit: Option<usize>,
}

#[cfg(not(target_arch = "wasm32"))]
fn default_worker_limit() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(8)
}

/// One tile the renderer wants rasterised: level index, world-anchored
/// address, the world rectangle it covers, and a ready-to-use per-tile
/// `RenderOptions` whose camera isolates the tile
/// (`device = world * zoom + view.xy`, tile origin pinned to device (0, 0)).
#[derive(Clone)]
pub struct TileRequest {
    pub level: usize,
    pub address: [i32; 2],
    pub world: [f64; 4],
    pub options: RenderOptions,
    pub pixel_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    /// The rendered instruction already equals the request: no tile was
    /// queued or rasterised.
    NoChange,
    /// Every visible tile of the owning level holds content at (at least)
    /// the instruction's revision.
    Completed,
}

/// Effective device scale of a level: the bucket scale the instruction
/// carries. `backing_scale` stays informational in the instruction (the
/// caller folds Retina factors into `zoom` before bucketing, the same way
/// `RenderOptions` expresses width/height in device pixels).
fn effective_scale(instruction: &RenderInstruction) -> f64 {
    instruction.level_scale
}

/// What the compositor should draw after `wait_for_content_render_semaphore`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresentDecision {
    /// Composite the freshly rendered tiles of the current level.
    PresentComposited,
    PresentPreviousLevel,
}

/// One tile the compositor should (re)upload. `byte_offset`/`byte_len` index
/// into [`TiledFrame::bytes`].
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TiledTile {
    pub level: usize,
    pub address: [i32; 2],
    /// World rectangle the tile covers at `level_scale`.
    pub world: [f64; 4],
    pub content_revision: u64,
    pub byte_offset: usize,
    pub byte_len: usize,
}

/// A canvas frame from the tiled renderer: the upload set plus frame-level
/// identity and telemetry, ready for a textured-quad compositor.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TiledFrame {
    pub status: UpdateStatus,
    pub level: usize,
    pub previous_level: Option<usize>,
    pub level_scale: f64,
    pub zoom: f64,
    pub telemetry: crate::render_telemetry::TelemetryReport,
    pub tiles: Vec<TiledTile>,
    #[serde(skip_serializing)]
    pub bytes: Vec<u8>,
}

/// A composited device-pixel frame straight from residency — what a host
/// that rebuilds the canvas per frame (wasm worker, native CPU-tiled host)
/// presents. Unlike [`TiledFrame`] this carries no tile byte payload: the
/// pixels are already composed, so nothing is concatenated for transfer.
pub struct AssembledFrame {
    pub status: UpdateStatus,
    pub level: usize,
    pub previous_level: Option<usize>,
    pub level_scale: f64,
    pub telemetry: crate::render_telemetry::TelemetryReport,
    /// Visible residency the composition read (cached + freshly rasterised).
    pub visible_tiles: usize,
    pub rgba: Vec<u8>,
}

/// Composite the frame's visible residency into the device viewport.
///
/// A bucket-snapped zoom (`zoom == level_scale`) takes the integer blit,
/// which is byte-identical to `Engine::render` at integer camera
/// translations — the frozen parity contract. An off-bucket zoom resamples
/// the bucket content bilinearly in premultiplied space: the `drawTiles`
/// fidelity tier Sketch presents while a zoom sits between bucket scales
/// (in-bucket zooms re-identify resident tiles, so nothing re-rasterises).
/// The two tiers never mix: byte-exactness stays a per-bucket claim.
pub fn assemble_rgba(frame: &TiledFrame, options: &RenderOptions) -> Vec<u8> {
    assemble_tiles(
        frame.tiles.iter().map(|tile| {
            (
                tile.world,
                &frame.bytes[tile.byte_offset..tile.byte_offset + tile.byte_len],
            )
        }),
        frame.level_scale,
        options,
    )
}

/// Composite `(world rect, RGBA8 bytes)` tiles into the device viewport —
/// the shared core behind [`assemble_rgba`] and the direct-from-residency
/// path of [`crate::renderer::Engine::render_tiled_frame`], which skips the
/// payload byte concatenation entirely.
pub fn assemble_tiles<'a>(
    tiles: impl Iterator<Item = ([f64; 4], &'a [u8])>,
    level: f64,
    options: &RenderOptions,
) -> Vec<u8> {
    let width = options.width as i64;
    let height = options.height as i64;
    let mut output = vec![0u8; (width * height * 4) as usize];
    let zoom = options.view.zoom;
    let snapped = (zoom - level).abs() <= f64::EPSILON * 4. * zoom.max(1.);
    let side = TILE_SIZE as usize;
    for (world, bytes) in tiles {
        // Engine camera contract: device = world * zoom + view.xy. The tile's
        // device span under the frame zoom (not the level scale) decides
        // which destination pixels it owns.
        let dx0 = world[0] * zoom + options.view.x;
        let dy0 = world[1] * zoom + options.view.y;
        let dx1 = (world[0] + world[2]) * zoom + options.view.x;
        let dy1 = (world[1] + world[3]) * zoom + options.view.y;
        if snapped {
            let dx = dx0.round() as i64;
            let dy = dy0.round() as i64;
            let side64 = TILE_SIZE as i64;
            if dx >= width || dy >= height || dx + side64 <= 0 || dy + side64 <= 0 {
                continue;
            }
            let x0 = dx.max(0);
            let y0 = dy.max(0);
            let x1 = (dx + side64).min(width);
            let y1 = (dy + side64).min(height);
            if x0 >= x1 || y0 >= y1 {
                continue;
            }
            for row in y0..y1 {
                // The tile is clipped at the viewport edge, so the first
                // blitted destination column maps to source column
                // `x0 - dx` — historically this offset was missing and every
                // mid-tile pan (view not a tile multiple) shifted content.
                let src = (((row - dy) as usize * side) + (x0 - dx) as usize) * 4;
                let dst = (row as usize * width as usize + x0 as usize) * 4;
                let span = (x1 - x0) as usize * 4;
                output[dst..dst + span].copy_from_slice(&bytes[src..src + span]);
            }
        } else {
            // Destination pixel p covers [p, p+1); it belongs to this tile
            // while its centre (p + 0.5) lies inside the tile's device span.
            // Shared world edges round to a shared destination edge, so
            // neighbouring tiles neither gap nor overlap.
            let x0 = ((dx0 - 0.5).ceil() as i64).max(0);
            let y0 = ((dy0 - 0.5).ceil() as i64).max(0);
            let x1 = ((dx1 - 0.5).ceil() as i64).min(width);
            let y1 = ((dy1 - 0.5).ceil() as i64).min(height);
            if x0 >= x1 || y0 >= y1 {
                continue;
            }
            let origin_x = world[0] * level;
            let origin_y = world[1] * level;
            let ratio = level / zoom;
            // Tap geometry is separable: resolve every column once per tile
            // instead of once per pixel, so the inner loop stays f32.
            let columns: Vec<(usize, usize, f32)> = (x0..x1)
                .map(|px| {
                    let lx = (px as f64 + 0.5 - options.view.x) * ratio - origin_x;
                    let cx = (lx - 0.5).clamp(0., side as f64 - 1.);
                    (cx as usize, (cx as usize + 1).min(side - 1), (cx - cx.floor()) as f32)
                })
                .collect();
            for py in y0..y1 {
                let ly = (py as f64 + 0.5 - options.view.y) * ratio - origin_y;
                let cy = (ly - 0.5).clamp(0., side as f64 - 1.);
                let iy = cy as usize;
                let jy = (iy + 1).min(side - 1);
                let fy = (cy - cy.floor()) as f32;
                let row_y = iy * side;
                let row_j = jy * side;
                let dst_row = (py as usize * width as usize + x0 as usize) * 4;
                for (column, (ix, jx, fx)) in columns.iter().enumerate() {
                    let dst = dst_row + column * 4;
                    let rgba = bilinear_premul_at(bytes, *ix, *jx, row_y, row_j, *fx, fy);
                    output[dst..dst + 4].copy_from_slice(&rgba);
                }
            }
        }
    }
    output
}

/// One bilinear tap over straight-alpha RGBA8 tile bytes, filtered in
/// premultiplied space so transparent texels contribute no colour. Taps
/// clamp at the tile edge; neighbouring tiles sample the same scene on the
/// shared world lattice, so edge duplication stays within one texel of the
/// filter footprint — the same trade Sketch's per-tile `drawTiles` placement
/// makes.
fn bilinear_premul_at(
    bytes: &[u8],
    ix: usize,
    jx: usize,
    row_y: usize,
    row_j: usize,
    fx: f32,
    fy: f32,
) -> [u8; 4] {
    let o00 = (row_y + ix) * 4;
    let o10 = (row_y + jx) * 4;
    let o01 = (row_j + ix) * 4;
    let o11 = (row_j + jx) * 4;
    let mut acc = [0f32; 4];
    for (o, w) in [
        (o00, (1. - fx) * (1. - fy)),
        (o10, fx * (1. - fy)),
        (o01, (1. - fx) * fy),
        (o11, fx * fy),
    ] {
        let a = f32::from(bytes[o + 3]);
        let weight = a * w / 255.;
        acc[0] += f32::from(bytes[o]) * weight;
        acc[1] += f32::from(bytes[o + 1]) * weight;
        acc[2] += f32::from(bytes[o + 2]) * weight;
        acc[3] += a * w;
    }
    let alpha = acc[3];
    if alpha <= 0. {
        return [0, 0, 0, 0];
    }
    let unpremultiply = |c: f32| ((c * 255. / alpha) + 0.5).floor().min(255.) as u8;
    [
        unpremultiply(acc[0]),
        unpremultiply(acc[1]),
        unpremultiply(acc[2]),
        (alpha + 0.5).floor().min(255.) as u8,
    ]
}

/// Rasterizes single tiles. Implemented by the engine (calling-thread path)
/// and by worker snapshots (parallel path).
pub trait TileRasterizer {
    fn rasterize_tile(&mut self, request: &TileRequest) -> Result<Vec<u8>, String>;
}

/// The tile-content source the tiled renderer drives. `spawn_worker` is the
/// seam Sketch's parallel rasterisation uses: every worker thread draws the
/// same immutable prepared scene into its own isolated context.
pub trait TileRasterSource: TileRasterizer {
    /// Content revision this source currently rasterises from. A mismatch
    /// with the instruction's revision is reported, never silently ignored.
    fn content_revision(&self) -> u64;
    /// Resolve animation, layout and asset state so spawned workers see the
    /// exact scene the calling thread would render.
    fn prepare(&mut self, options: &RenderOptions) -> Result<(), String>;
    /// Build one isolated rasterizer for a worker thread, sharing the
    /// prepared scene. `None` means this source cannot be shared; the update
    /// degrades to the calling-thread rasterizer.
    fn spawn_worker(&self) -> Option<Box<dyn TileRasterizer + Send>>;
}

pub struct CacheManager {
    zoom_independent: HashMap<([i32; 2], u64), Arc<Vec<u8>>>,
    zoom_level_for_shared_cache: Option<f64>,
    insertion_order: Vec<([i32; 2], u64)>,
    budget_bytes: usize,
    stored_bytes: usize,
}

impl Default for CacheManager {
    fn default() -> Self {
        CacheManager::new(512 * 1024 * 1024)
    }
}

impl CacheManager {
    pub fn new(budget_bytes: usize) -> Self {
        CacheManager {
            zoom_independent: HashMap::new(),
            zoom_level_for_shared_cache: None,
            insertion_order: Vec::new(),
            budget_bytes,
            stored_bytes: 0,
        }
    }

    /// Promote a fully covered level into the zoom-independent store.
    pub fn promote_level(&mut self, level: &TileMipLevel, revision: u64) {
        self.zoom_level_for_shared_cache = Some(level.scale());
        for entry in level.tiles() {
            let key = (entry.address, revision);
            let bytes = entry.surface.stored_bytes();
            if !self.zoom_independent.contains_key(&key) {
                self.stored_bytes += bytes;
                self.insertion_order.push(key);
            }
            self.zoom_independent
                .insert(key, entry.surface.share_bytes());
        }
        self.evict_to_budget();
    }

    /// Lookup a cached tile; hits are only valid at the shared zoom level
    /// and the exact content revision.
    pub fn lookup(
        &self,
        address: [i32; 2],
        revision: u64,
        scale: f64,
    ) -> Option<Arc<Vec<u8>>> {
        if self.zoom_level_for_shared_cache != Some(scale) {
            return None;
        }
        self.zoom_independent.get(&(address, revision)).cloned()
    }

    /// `invalidateCachesForInstruction:` content half — drop entries from
    /// revisions older than `revision`.
    pub fn invalidate_for_revision(&mut self, revision: u64) {
        let stale: Vec<_> = self
            .insertion_order
            .iter()
            .copied()
            .filter(|(_, cached)| *cached < revision)
            .collect();
        for key in stale {
            if let Some(bytes) = self.zoom_independent.remove(&key) {
                self.stored_bytes -= bytes.len();
            }
        }
        self.insertion_order.retain(|(_, cached)| *cached >= revision);
    }

    pub fn clear(&mut self) {
        self.zoom_independent.clear();
        self.insertion_order.clear();
        self.stored_bytes = 0;
        self.zoom_level_for_shared_cache = None;
    }

    fn evict_to_budget(&mut self) {
        while self.stored_bytes > self.budget_bytes {
            let Some(oldest) = self.insertion_order.first().copied() else {
                break;
            };
            self.insertion_order.remove(0);
            if let Some(bytes) = self.zoom_independent.remove(&oldest) {
                self.stored_bytes -= bytes.len();
            }
        }
    }

    pub fn zoom_level_for_shared_cache(&self) -> Option<f64> {
        self.zoom_level_for_shared_cache
    }

    pub fn entry_count(&self) -> usize {
        self.zoom_independent.len()
    }

    pub fn stored_bytes(&self) -> usize {
        self.stored_bytes
    }
}

pub fn level_index_for_scale(scale: f64) -> usize {
    if !scale.is_finite() || scale <= 0.1 {
        return 0;
    }
    // 0.25 -> 1, 0.5 -> 2, 1 -> 3, 2 -> 4, doubling onwards.
    let index = 1.0 + (scale / 0.25).log2();
    (index.round() as i64).max(0) as usize
}

/// The Sketch-parity tiled renderer. Owns mip levels, the rendered and
/// composited instructions, the surface pool, caches and telemetry; drives a
/// [`TileRasterSource`] for actual pixel work.
pub struct TiledRenderer {
    levels: Vec<Option<TileMipLevel>>,
    rendered_instruction: Option<RenderInstruction>,
    composited_instruction: Option<RenderInstruction>,
    previous_level: Option<usize>,
    clear_other_levels: bool,
    force_sync_first_frame: bool,
    rasterisation_in_progress: bool,
    flags: RenderFeatureFlags,
    telemetry: RenderingTelemetry,
    surfaces: RasterSurfacePool,
    caches: CacheManager,
    last_level: Option<usize>,
    /// Addresses committed by the most recent update (cache-serviced and
    /// rasterised) — the compositor's redraw set. An equal-instruction
    /// update leaves it empty.
    last_committed: Vec<[i32; 2]>,
}

impl Default for TiledRenderer {
    fn default() -> Self {
        TiledRenderer::new(RenderFeatureFlags::default())
    }
}

impl TiledRenderer {
    pub fn new(flags: RenderFeatureFlags) -> Self {
        TiledRenderer {
            levels: Vec::new(),
            rendered_instruction: None,
            composited_instruction: None,
            previous_level: None,
            clear_other_levels: false,
            force_sync_first_frame: true,
            rasterisation_in_progress: false,
            flags,
            telemetry: RenderingTelemetry::new(32),
            surfaces: RasterSurfacePool::default(),
            caches: CacheManager::default(),
            last_level: None,
            last_committed: Vec::new(),
        }
    }

    /// Tiles committed by the most recent update — the compositor's redraw
    /// set. Empty when the instruction compared equal and nothing rasterised.
    pub fn last_committed(&self) -> &[[i32; 2]] {
        &self.last_committed
    }

    pub fn flags(&self) -> &RenderFeatureFlags {
        &self.flags
    }

    pub fn set_flags(&mut self, flags: RenderFeatureFlags) {
        self.flags = flags;
    }

    pub fn telemetry(&self) -> &RenderingTelemetry {
        &self.telemetry
    }

    pub fn telemetry_mut(&mut self) -> &mut RenderingTelemetry {
        &mut self.telemetry
    }

    pub fn surfaces(&self) -> &RasterSurfacePool {
        &self.surfaces
    }

    pub fn caches(&self) -> &CacheManager {
        &self.caches
    }

    pub fn rendered_instruction(&self) -> Option<&RenderInstruction> {
        self.rendered_instruction.as_ref()
    }

    pub fn composited_instruction(&self) -> Option<&RenderInstruction> {
        self.composited_instruction.as_ref()
    }

    pub fn previous_level(&self) -> Option<usize> {
        self.previous_level
    }

    pub fn set_clear_other_levels(&mut self, clear: bool) {
        self.clear_other_levels = clear;
    }

    pub fn set_force_sync_first_frame(&mut self, sync: bool) {
        self.force_sync_first_frame = sync;
    }

    pub fn rasterisation_in_progress(&self) -> bool {
        self.rasterisation_in_progress
    }

    /// `tileLevelWithScale:` — the level owning `scale`, created on first
    /// use. Returns its index in the ladder.
    fn ensure_level(&mut self, scale: f64, color_space: &crate::render_instruction::ColorSpaceId) -> Result<usize, String> {
        let index = level_index_for_scale(scale);
        if self.levels.len() <= index {
            self.levels.resize_with(index + 1, || None);
        }
        if self.levels[index].is_none() {
            self.levels[index] = Some(TileMipLevel::new(scale));
        }
        let level = self
            .levels
            .get_mut(index)
            .and_then(|slot| slot.as_mut())
            .expect("level just ensured");
        level.set_current_color_space(color_space.clone());
        Ok(index)
    }

    /// Read access to one level (the compositor's upload loop).
    pub fn level(&self, index: usize) -> Option<&TileMipLevel> {
        self.levels.get(index).and_then(|slot| slot.as_ref())
    }

    /// `tileLevelWithScale:` for callers that already hold a scale.
    pub fn tile_level_with_scale(&mut self, scale: f64) -> Result<usize, String> {
        self.ensure_level(scale, &crate::render_instruction::ColorSpaceId::of(&None))
    }

    /// The one entry point: `updateWithInstruction:synchronously:hasUserFocus:`.
    ///
    /// `synchronously` forces completion in this call (in the sync kernel the
    /// raster loop always runs to completion; the flag keeps the Sketch
    /// signature and gates the present decision). `damage` carries the
    /// world-space edit rectangles from [`crate::dirty_region`]; `None` with
    /// a moved content revision means full repaint of visible tiles.
    pub fn update_with_instruction(
        &mut self,
        source: &mut dyn TileRasterSource,
        options: &RenderOptions,
        instruction: &RenderInstruction,
        damage: Option<&[WorldRect]>,
    ) -> Result<UpdateStatus, String> {
        if options.page_id != instruction.page_id {
            return Err("Frame options and instruction name different pages".into());
        }
        if source.content_revision() != instruction.content_revision {
            return Err(format!(
                "Raster source revision {} does not match instruction revision {}",
                source.content_revision(),
                instruction.content_revision
            ));
        }
        let traits = self
            .rendered_instruction
            .as_ref()
            .map(|previous| instruction.traits_differing(previous))
            .unwrap_or(u64::MAX);
        if traits == 0 {
            return Ok(UpdateStatus::NoChange);
        }
        let index = self.ensure_level(instruction.level_scale, &instruction.color_space)?;
        let first_frame = self.rendered_instruction.is_none();
        if !first_frame && traits & render_trait::ZOOM_BUCKET != 0 {
            // The old level stays resident for upscaled display while the
            // new one fills (`previousLevel` + `clearOtherLevels`).
            self.previous_level = self.last_level;
            if self.clear_other_levels {
                for (other, slot) in self.levels.iter_mut().enumerate() {
                    if other != index
                        && let Some(level) = slot.as_mut()
                    {
                        level.remove_all_tiles_and_clear_dirty_region();
                    }
                }
            }
        }
        let content_moved = traits
            & (render_trait::CONTENT
                | render_trait::OPTIONS
                | render_trait::COLOR_SPACE
                | render_trait::OVERLAY)
            != 0;
        if content_moved || first_frame {
            self.invalidate_caches_for_instruction(instruction, damage)?;
        }
        let scale = effective_scale(instruction);
        // Split the queue: cache-serviced tiles commit without rasterising,
        // the rest become tile requests for the (parallel) rasteriser.
        let queued = {
            let level = self
                .levels
                .get_mut(index)
                .and_then(|slot| slot.as_mut())
                .expect("level ensured above");
            level.enqueue_renderable_tiles_for_visible_rect(
                instruction.viewport,
                instruction.content_revision,
            )?
        };
        self.last_committed.clear();
        let mut addresses = Vec::with_capacity(queued.len());
        for address in queued {
            match self
                .caches
                .lookup(address, instruction.content_revision, scale)
            {
                Some(bytes) => {
                    let level = self
                        .levels
                        .get_mut(index)
                        .and_then(|slot| slot.as_mut())
                        .expect("level ensured above");
                    let mut surface = self.surfaces.vend(TILE_SIZE as u32, TILE_SIZE as u32);
                    surface.replace_region(
                        (0, 0, TILE_SIZE as u32, TILE_SIZE as u32),
                        &bytes,
                        TILE_SIZE as usize * 4,
                    )?;
                    level.commit_tile(address, surface, instruction.content_revision);
                    self.last_committed.push(address);
                }
                None => addresses.push(address),
            }
        }
        if !addresses.is_empty() {
            source.prepare(options)?;
            let requests = self.tile_requests(index, scale, addresses, options);
            self.rasterisation_in_progress = true;
            let outcome = self.rasterise_requests(source, requests);
            self.rasterisation_in_progress = false;
            let tiles = outcome?;
            self.last_committed
                .extend(tiles.iter().map(|(address, _)| *address));
            self.commit_rasterised(index, instruction.content_revision, tiles)?;
        }
        self.last_level = Some(index);
        self.rendered_instruction = Some(instruction.clone());
        // Promote a fully covered level into the zoom-independent cache.
        {
            let level = self
                .levels
                .get(index)
                .and_then(|slot| slot.as_ref())
                .expect("level ensured above");
            let total = level.addresses_for_world(instruction.viewport)?.len();
            let covered = level.count_existing_tiles_for_visible_rect(
                instruction.viewport,
                instruction.content_revision,
            )?;
            if total > 0 && covered == total {
                self.caches.promote_level(level, instruction.content_revision);
            }
        }
        Ok(UpdateStatus::Completed)
    }

    fn tile_requests(
        &self,
        level: usize,
        scale: f64,
        addresses: Vec<[i32; 2]>,
        frame: &RenderOptions,
    ) -> Vec<TileRequest> {
        let tile_world = f64::from(TILE_SIZE) / scale;
        addresses
            .into_iter()
            .map(|address| {
                let world = [
                    address[0] as f64 * tile_world,
                    address[1] as f64 * tile_world,
                    tile_world,
                    tile_world,
                ];
                let mut options = frame.clone();
                options.width = TILE_SIZE as u32;
                options.height = TILE_SIZE as u32;
                options.pixel_preview = None;
                // Tile origin pinned to device (0, 0): with the engine camera
                // `device = world * zoom + view.xy`, that means view.xy = −world*scale.
                options.view = View {
                    x: -world[0] * scale,
                    y: -world[1] * scale,
                    zoom: scale,
                };
                TileRequest {
                    level,
                    address,
                    world,
                    options,
                    pixel_count: TILE_SIZE as u64 * TILE_SIZE as u64,
                }
            })
            .collect()
    }

    /// `_doParallelRasterisationOfScene:inRects:…` — sequential or bounded
    /// worker-pool rasterisation of the queued tiles, chosen by the feature
    /// flags. Deterministic order: results return in request order whatever
    /// the scheduling.
    fn rasterise_requests(
        &mut self,
        source: &mut dyn TileRasterSource,
        requests: Vec<TileRequest>,
    ) -> Result<RasterisedTiles, String> {
        let count = requests.len();
        if count == 0 {
            return Ok(Vec::new());
        }
        let parallel = self.flags.rasterize_concurrently
            && !self.flags.single_threaded_content_rendering
            && count > 1;
        if !parallel {
            return self.rasterise_sequential(source, requests);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.rasterise_parallel(source, requests)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.rasterise_sequential(source, requests)
        }
    }

    fn rasterise_sequential(
        &mut self,
        source: &mut dyn TileRasterSource,
        requests: Vec<TileRequest>,
    ) -> Result<RasterisedTiles, String> {
        let mut tiles = Vec::with_capacity(requests.len());
        for request in &requests {
            self.telemetry
                .begin_rasterisation_with_pixel_count(request.pixel_count);
            let bytes = source.rasterize_tile(request);
            self.telemetry.end_rasterisation();
            tiles.push((request.address, bytes?));
        }
        Ok(tiles)
    }

    /// Bounded worker-pool rasterisation: workers pull tile indices from an
    /// atomic cursor, results land in pre-slotted positions, and the return
    /// order is the request order whatever the scheduling. Telemetry records
    /// one span per tile with its pixel count; spans are booked after the
    /// scope joins (workers cannot share the non-`Sync` telemetry), so
    /// parallel durations are not wall-accurate — counts are exact.
    #[cfg(not(target_arch = "wasm32"))]
    fn rasterise_parallel(
        &mut self,
        source: &mut dyn TileRasterSource,
        requests: Vec<TileRequest>,
    ) -> Result<RasterisedTiles, String> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Mutex;
        /// One worker's slot in the parallel rasterisation result vector.
        type RasterSlot = Option<Result<Vec<u8>, String>>;
        let worker_count = self
            .flags
            .worker_limit
            .unwrap_or_else(default_worker_limit)
            .max(1)
            .min(requests.len());
        let workers: Vec<Box<dyn TileRasterizer + Send>> = (0..worker_count)
            .map(|_| source.spawn_worker())
            .collect::<Option<Vec<_>>>()
            .ok_or("Raster source cannot spawn parallel workers")?;
        let next = AtomicUsize::new(0);
        let slots: Mutex<Vec<RasterSlot>> = Mutex::new((0..requests.len()).map(|_| None).collect());
        let telemetry_pixels: Vec<u64> = requests.iter().map(|r| r.pixel_count).collect();
        std::thread::scope(|scope| {
            for mut worker in workers {
                let next = &next;
                let slots = &slots;
                let requests = &requests;
                scope.spawn(move || {
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        if index >= requests.len() {
                            break;
                        }
                        let outcome = worker.rasterize_tile(&requests[index]);
                        if let Ok(mut guard) = slots.lock() {
                            guard[index] = Some(outcome);
                        }
                    }
                });
            }
        });
        let results = slots.into_inner().expect("scope joined all lock guards");
        let mut tiles = Vec::with_capacity(requests.len());
        for (index, result) in results.into_iter().enumerate() {
            let bytes = result.unwrap_or_else(|| {
                Err("Parallel rasterisation ended with an unanswered tile".into())
            })?;
            self.telemetry
                .begin_rasterisation_with_pixel_count(telemetry_pixels[index]);
            self.telemetry.end_rasterisation();
            tiles.push((requests[index].address, bytes));
        }
        Ok(tiles)
    }

    fn commit_rasterised(
        &mut self,
        level_index: usize,
        revision: u64,
        tiles: Vec<([i32; 2], Vec<u8>)>,
    ) -> Result<(), String> {
        let level = self
            .levels
            .get_mut(level_index)
            .and_then(|slot| slot.as_mut())
            .expect("level ensured above");
        for (address, bytes) in tiles {
            if bytes.len() != TILE_SIZE as usize * TILE_SIZE as usize * 4 {
                return Err(format!(
                    "Tile {address:?} rasterised {} bytes, expected {}",
                    bytes.len(),
                    TILE_SIZE as usize * TILE_SIZE as usize * 4
                ));
            }
            let surface = match level.find_writable_tile_at(address) {
                Some(mut surface) => {
                    surface.replace_region(
                        (0, 0, TILE_SIZE as u32, TILE_SIZE as u32),
                        &bytes,
                        TILE_SIZE as usize * 4,
                    )?;
                    surface
                }
                None => {
                    let mut surface =
                        self.surfaces.vend(TILE_SIZE as u32, TILE_SIZE as u32);
                    surface.replace_region(
                        (0, 0, TILE_SIZE as u32, TILE_SIZE as u32),
                        &bytes,
                        TILE_SIZE as usize * 4,
                    )?;
                    surface
                }
            };
            level.commit_tile(address, surface, revision);
        }
        Ok(())
    }

    /// `invalidateCachesForInstruction:` — apply edit damage to the owning
    /// level, retire or restamp stale residency and drop cache entries the
    /// content revision left behind.
    pub fn invalidate_caches_for_instruction(
        &mut self,
        instruction: &RenderInstruction,
        damage: Option<&[WorldRect]>,
    ) -> Result<(), String> {
        self.caches.invalidate_for_revision(instruction.content_revision);
        let index = level_index_for_scale(instruction.level_scale);
        for (other, slot) in self.levels.iter_mut().enumerate() {
            let Some(level) = slot.as_mut() else {
                continue;
            };
            match damage {
                Some(rects) => {
                    // Bounded damage: mark the touched area dirty on the
                    // owning level; every scale's tiles outside the damage
                    // are the same unchanged content and restamp to the new
                    // revision (tiles inside damage keep their stale revision
                    // and re-rasterise when their level next renders).
                    if other == index {
                        for rect in rects {
                            level.mark_dirty_world(*rect)?;
                        }
                    }
                    level.restamp_outside_damage(rects, instruction.content_revision);
                }
                None => {
                    level.retire_tiles_below(instruction.content_revision);
                }
            }
        }
        Ok(())
    }

    pub fn wait_for_content_render_semaphore(
        &self,
        pending: &RenderInstruction,
        synchronously: bool,
        has_user_focus: bool,
    ) -> PresentDecision {
        let content_ready = self
            .rendered_instruction
            .as_ref()
            .is_some_and(|rendered| rendered.traits_differing(pending) == 0);
        if content_ready
            || synchronously
            || has_user_focus
            || (self.force_sync_first_frame && self.composited_instruction.is_none())
        {
            PresentDecision::PresentComposited
        } else {
            PresentDecision::PresentPreviousLevel
        }
    }

    /// `note composited` — the host drew a frame from the committed tiles;
    /// advances the telemetry frame count, the axis independent of
    /// rasterisation spans.
    pub fn note_composited(&mut self, instruction: &RenderInstruction) {
        self.composited_instruction = Some(instruction.clone());
        self.telemetry.count_frame();
    }

    /// `removeAllTilesAndClearDirtyRegions` — drop every level's residency.
    pub fn remove_all_tiles_and_clear_dirty_regions(&mut self) {
        for slot in &mut self.levels {
            if let Some(level) = slot.as_mut() {
                level.remove_all_tiles_and_clear_dirty_region();
            }
        }
    }

    /// Bytes currently held across all levels (diagnostics for hosts sizing
    /// GPU texture pools against CPU residency).
    pub fn resident_tile_count(&self) -> usize {
        self.levels
            .iter()
            .filter_map(|slot| slot.as_ref())
            .map(TileMipLevel::tile_count)
            .sum()
    }

    pub fn resident_bytes(&self) -> usize {
        self.levels
            .iter()
            .flatten()
            .map(|level| {
                level
                    .tiles()
                    .map(|entry| entry.surface.bytes().len())
                    .sum::<usize>()
            })
            .sum()
    }

    /// The budget guard shared with the dirty-region derivation.
    pub fn tile_limit() -> usize {
        LEVEL_TILE_LIMIT
    }
}
