//! Per-scale tile residency — the mip level that owns rendered content.
//!
//! Sketch's `MSTileMipLevel` is one scale bucket of `MSTile`s plus its
//! *own* dirty region:
//! `enqueueRenderableTilesForVisibleRect:` queues only visible tiles that are
//! missing or dirty, `countExistingTilesForVisibleRect:` reports coverage,
//! `subtractDirtyRect:` retires damage after an upload, `findWritableTileAt:`
//! reuses a resident tile instead of allocating, and a colour-space mismatch
//! (`isCurrentColorSpaceEqualTo:`) drops the whole level with
//! `clearBeforeUpload` set for its rebuild.
//!
//! Tile addresses reuse [`crate::tile_stack::raster_addresses`]: world
//! multiples of [`crate::tile_stack::TILE_SIZE`] at the level's fixed scale,
//! so a pan re-identifies resident tiles and only newly exposed ones render.

use crate::raster_surface::RasterSurface;
use crate::render_instruction::ColorSpaceId;
use crate::tile_stack::raster_addresses;
use std::collections::HashMap;

/// Upper bound on addresses one level may hold before it evicts the least
/// recently observed tile — the tile-budget honesty rule shared with the
/// dirty-region derivation.
pub const LEVEL_TILE_LIMIT: usize = 512;

/// One resident tile: its world-anchored address, the surface holding its
/// pixels, the content revision the pixels were rasterised from, and the
/// observation stamp driving eviction.
#[derive(Clone)]
pub struct TileEntry {
    pub address: [i32; 2],
    pub surface: RasterSurface,
    pub content_revision: u64,
    observed: u64,
    committed: u64,
}

/// Dirty damage in device pixels at this level's scale, stored as a small
/// rect list — the dump shows a plain `dirtyRegion` with
/// `subtractDirtyRect:`, and damage lists here are short (one per edit or
/// reveal).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DirtyRects {
    rects: Vec<(i32, i32, i32, i32)>,
}

impl DirtyRects {
    pub fn is_empty(&self) -> bool {
        self.rects.is_empty()
    }

    pub fn rects(&self) -> &[(i32, i32, i32, i32)] {
        &self.rects
    }

    pub fn clear(&mut self) {
        self.rects.clear();
    }

    /// Add a device-pixel rectangle, collapsing containment duplicates.
    pub fn add(&mut self, rect: (i32, i32, i32, i32)) {
        if rect.2 <= 0 || rect.3 <= 0 {
            return;
        }
        if self.rects.iter().any(|r| covers(*r, rect)) {
            return;
        }
        self.rects.retain(|r| !covers(rect, *r));
        self.rects.push(rect);
    }

    /// `subtractDirtyRect:` — retire the intersection with one uploaded
    /// rectangle, splitting what remains into up to four pieces.
    pub fn subtract(&mut self, hole: (i32, i32, i32, i32)) {
        if hole.2 <= 0 || hole.3 <= 0 {
            return;
        }
        let mut next = Vec::with_capacity(self.rects.len());
        for rect in self.rects.drain(..) {
            subtract_rect(rect, hole, &mut next);
        }
        self.rects = next;
    }

    /// Bounding union of the damage, for diagnostics.
    pub fn union_device_rects(&self) -> Option<(i32, i32, i32, i32)> {
        let first = *self.rects.first()?;
        let mut bounds = first;
        for rect in &self.rects[1..] {
            let x1 = (bounds.0 + bounds.2).max(rect.0 + rect.2);
            let y1 = (bounds.1 + bounds.3).max(rect.1 + rect.3);
            bounds.0 = bounds.0.min(rect.0);
            bounds.1 = bounds.1.min(rect.1);
            bounds.2 = x1 - bounds.0;
            bounds.3 = y1 - bounds.1;
        }
        Some(bounds)
    }
}

fn covers(outer: (i32, i32, i32, i32), inner: (i32, i32, i32, i32)) -> bool {
    outer.0 <= inner.0
        && outer.1 <= inner.1
        && outer.0 + outer.2 >= inner.0 + inner.2
        && outer.1 + outer.3 >= inner.1 + inner.3
}

/// Subtract `hole` from `rect`, appending the remainder pieces.
fn subtract_rect(
    rect: (i32, i32, i32, i32),
    hole: (i32, i32, i32, i32),
    out: &mut Vec<(i32, i32, i32, i32)>,
) {
    let left = hole.0.max(rect.0);
    let top = hole.1.max(rect.1);
    let right = (hole.0 + hole.2).min(rect.0 + rect.2);
    let bottom = (hole.1 + hole.3).min(rect.1 + rect.3);
    if left >= right || top >= bottom {
        out.push(rect);
        return;
    }
    // Top band, bottom band, then left/right bands of the middle stripe.
    if rect.1 < top {
        out.push((rect.0, rect.1, rect.2, top - rect.1));
    }
    if bottom < rect.1 + rect.3 {
        out.push((rect.0, bottom, rect.2, rect.1 + rect.3 - bottom));
    }
    if rect.0 < left {
        out.push((rect.0, top, left - rect.0, bottom - top));
    }
    if right < rect.0 + rect.2 {
        out.push((right, top, rect.0 + rect.2 - right, bottom - top));
    }
}

/// One scale bucket of resident tiles. All geometry is world→device at the
/// level's fixed `scale`; the live camera only chooses *which* level owns
/// content and how the compositor resamples it.
pub struct TileMipLevel {
    scale: f64,
    tiles: HashMap<[i32; 2], TileEntry>,
    dirty: DirtyRects,
    /// `clearBeforeUpload`: the next upload must clear before drawing, set
    /// when residency was dropped for a colour-space change.
    clear_before_upload: bool,
    color_space: Option<ColorSpaceId>,
    /// Monotonic stamps: `epoch` bumps on observation, `sequence` on commit.
    /// Eviction orders by (observed, committed) so both orders are
    /// deterministic across runs.
    epoch: u64,
    sequence: u64,
}

impl TileMipLevel {
    pub fn new(scale: f64) -> Self {
        TileMipLevel {
            scale,
            tiles: HashMap::new(),
            dirty: DirtyRects::default(),
            clear_before_upload: false,
            color_space: None,
            epoch: 0,
            sequence: 0,
        }
    }

    pub fn scale(&self) -> f64 {
        self.scale
    }

    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }

    pub fn dirty_region(&self) -> &DirtyRects {
        &self.dirty
    }

    pub fn clear_before_upload(&self) -> bool {
        self.clear_before_upload
    }

    pub fn tile(&self, address: &[i32; 2]) -> Option<&TileEntry> {
        self.tiles.get(address)
    }

    pub fn tiles(&self) -> impl Iterator<Item = &TileEntry> {
        self.tiles.values()
    }

    /// `isCurrentColorSpaceEqualTo:` — `false` means every tile is invalid.
    pub fn is_current_color_space_equal_to(&self, id: &ColorSpaceId) -> bool {
        self.color_space.as_ref() == Some(id)
    }

    /// Adopt a colour space, dropping residency on a change and arming
    /// `clearBeforeUpload` — the sequence the dump shows around
    /// `setCurrentColorSpace:` + `setClearBeforeUpload:`.
    pub fn set_current_color_space(&mut self, id: ColorSpaceId) {
        if self.color_space.as_ref() != Some(&id) {
            self.tiles.clear();
            self.dirty.clear();
            self.clear_before_upload = true;
            self.color_space = Some(id);
        }
    }

    /// World rectangle covered by a tile address at this level's scale.
    pub fn tile_world_rect(&self, address: [i32; 2]) -> [f64; 4] {
        let tile = f64::from(crate::tile_stack::TILE_SIZE) / self.scale;
        [
            address[0] as f64 * tile,
            address[1] as f64 * tile,
            tile,
            tile,
        ]
    }

    /// Device-pixel rectangle of a tile at this level's scale.
    fn tile_device_rect(&self, address: [i32; 2]) -> (i32, i32, i32, i32) {
        let side = crate::tile_stack::TILE_SIZE;
        (address[0] * side, address[1] * side, side, side)
    }

    /// Addresses covering a world viewport at this level's scale
    /// (`raster_addresses`, world-anchored so pans re-identify tiles).
    pub fn addresses_for_world(&self, world: [f64; 4]) -> Result<Vec<[i32; 2]>, String> {
        raster_addresses(world, self.scale, LEVEL_TILE_LIMIT, [0., 0.])
    }

    /// Mark a world rectangle dirty at this level.
    pub fn mark_dirty_world(&mut self, world: [f64; 4]) -> Result<(), String> {
        for address in self.addresses_for_world(world)? {
            let device = self.tile_device_rect(address);
            self.dirty.add(device);
        }
        Ok(())
    }

    /// `enqueueRenderableTilesForVisibleRect:` — visible tiles that are
    /// missing, stale by revision, or dirty. Row-major order keeps
    /// rasterisation deterministic; observed tiles advance the LRU epoch.
    pub fn enqueue_renderable_tiles_for_visible_rect(
        &mut self,
        world: [f64; 4],
        content_revision: u64,
    ) -> Result<Vec<[i32; 2]>, String> {
        self.epoch = self.epoch.wrapping_add(1);
        let mut renderable = Vec::new();
        for address in self.addresses_for_world(world)? {
            let missing_or_stale = self
                .tiles
                .get(&address)
                .is_none_or(|entry| entry.content_revision < content_revision);
            let needs = missing_or_stale || self.dirty_covers(address);
            if let Some(entry) = self.tiles.get_mut(&address) {
                entry.observed = self.epoch;
            }
            if needs {
                renderable.push(address);
            }
        }
        Ok(renderable)
    }

    fn dirty_covers(&self, address: [i32; 2]) -> bool {
        let device = self.tile_device_rect(address);
        self.dirty.rects().iter().any(|r| intersects(*r, device))
    }

    /// `countExistingTilesForVisibleRect:` — how many visible addresses
    /// already hold content at (at least) `content_revision`.
    pub fn count_existing_tiles_for_visible_rect(
        &self,
        world: [f64; 4],
        content_revision: u64,
    ) -> Result<usize, String> {
        Ok(self
            .addresses_for_world(world)?
            .into_iter()
            .filter(|address| {
                self.tiles
                    .get(address)
                    .is_some_and(|t| t.content_revision >= content_revision)
            })
            .count())
    }

    /// `findWritableTileAt:` — a resident tile whose pixels are about to be
    /// fully replaced, so its surface can be reused rather than re-vended.
    pub fn find_writable_tile_at(&mut self, address: [i32; 2]) -> Option<RasterSurface> {
        self.tiles.remove(&address).map(|entry| entry.surface)
    }

    /// Store a freshly rasterised tile and `subtractDirtyRect:` its extent.
    pub fn commit_tile(
        &mut self,
        address: [i32; 2],
        surface: RasterSurface,
        content_revision: u64,
    ) {
        if self.tiles.len() >= LEVEL_TILE_LIMIT && !self.tiles.contains_key(&address) {
            // Evict the least recently observed tile to stay in budget;
            // (observed, committed) ordering keeps eviction deterministic.
            if let Some(oldest) = self
                .tiles
                .iter()
                .min_by_key(|(_, entry)| (entry.observed, entry.committed, entry.address))
                .map(|(address, _)| *address)
            {
                self.tiles.remove(&oldest);
            }
        }
        let device = self.tile_device_rect(address);
        self.sequence += 1;
        let sequence = self.sequence;
        self.tiles.insert(
            address,
            TileEntry {
                address,
                surface,
                content_revision,
                observed: self.epoch,
                committed: sequence,
            },
        );
        self.dirty.subtract(device);
        self.clear_before_upload = false;
    }

    /// `removeAllTilesAndClearDirtyRegion`.
    pub fn remove_all_tiles_and_clear_dirty_region(&mut self) {
        self.tiles.clear();
        self.dirty.clear();
    }

    /// Retire tiles below `revision` from residency (an edit invalidates
    /// their content without enqueueing anything yet).
    pub fn retire_tiles_below(&mut self, revision: u64) {
        self.tiles.retain(|_, entry| entry.content_revision >= revision);
    }

    /// Restamp tiles that provably kept their pixels: when a damage list
    /// covers an edit, every tile outside it is unchanged and adopts the new
    /// content revision without re-rasterising — the "few renders" half of
    /// the dirty-region contract. An empty damage list restamps everything.
    pub fn restamp_outside_damage(&mut self, damage: &[crate::render_instruction::WorldRect], revision: u64) {
        let tile_world_side = f64::from(crate::tile_stack::TILE_SIZE) / self.scale;
        for entry in self.tiles.values_mut() {
            if entry.content_revision >= revision {
                continue;
            }
            let (x, y) = (
                entry.address[0] as f64 * tile_world_side,
                entry.address[1] as f64 * tile_world_side,
            );
            let touched = damage.iter().any(|rect| {
                rect[0] < x + tile_world_side
                    && x < rect[0] + rect[2]
                    && rect[1] < y + tile_world_side
                    && y < rect[1] + rect[3]
            });
            if !touched {
                entry.content_revision = revision;
            }
        }
    }

    /// Addresses of resident tiles — deterministic order for callers that
    /// walk residency (tests, cache seeding, compositor upload loops).
    pub fn resident_addresses(&self) -> Vec<[i32; 2]> {
        let mut addresses: Vec<[i32; 2]> = self.tiles.keys().copied().collect();
        addresses.sort_unstable();
        addresses
    }
}

fn intersects(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level() -> TileMipLevel {
        TileMipLevel::new(1.)
    }

    fn surface(tag: u8) -> RasterSurface {
        let mut surface = RasterSurface::new(512, 512);
        surface
            .replace_region((0, 0, 512, 512), &vec![tag; 512 * 512 * 4], 512 * 4)
            .expect("full tile region");
        surface
    }

    #[test]
    fn enqueue_reports_missing_and_dirty_tiles_only() {
        let mut level = level();
        level.commit_tile([0, 0], surface(1), 5);
        level.commit_tile([1, 0], surface(2), 5);
        let queue = level
            .enqueue_renderable_tiles_for_visible_rect([0., 0., 1024., 1024.], 5)
            .expect("visible rect");
        assert_eq!(queue, vec![[0, 1], [1, 1]], "resident tiles are skipped");
        // A dirty rect over tile [0,0] re-queues exactly that tile.
        level.mark_dirty_world([0., 0., 512., 512.]).expect("dirty");
        let queue = level
            .enqueue_renderable_tiles_for_visible_rect([0., 0., 512., 512.], 5)
            .expect("visible rect");
        assert_eq!(queue, vec![[0, 0]]);
        // A content revision bump re-queues every visible stale tile.
        let queue = level
            .enqueue_renderable_tiles_for_visible_rect([0., 0., 512., 512.], 6)
            .expect("visible rect");
        assert_eq!(queue, vec![[0, 0]]);
        level.commit_tile([0, 0], surface(3), 6);
        assert_eq!(
            level
                .count_existing_tiles_for_visible_rect([0., 0., 512., 512.], 6)
                .expect("count"),
            1
        );
    }

    #[test]
    fn pan_reuses_resident_tiles() {
        let mut level = level();
        for address in [[0, 0], [1, 0], [2, 0]] {
            level.commit_tile(address, surface(7), 1);
        }
        // Panning right by one tile width: only the newly exposed column
        // queues; the two still-visible resident tiles are reused.
        let queue = level
            .enqueue_renderable_tiles_for_visible_rect([512., 0., 1024., 512.], 1)
            .expect("visible rect");
        assert!(queue.is_empty(), "fully covered pan reuses everything");
        let queue = level
            .enqueue_renderable_tiles_for_visible_rect([1024., 0., 1024., 512.], 1)
            .expect("visible rect");
        assert_eq!(queue, vec![[3, 0]], "only the exposed column renders");
    }

    #[test]
    fn subtract_dirty_rect_splits_remainders() {
        let mut dirty = DirtyRects::default();
        dirty.add((0, 0, 100, 100));
        dirty.subtract((25, 25, 50, 50));
        assert_eq!(dirty.rects().len(), 4);
        let union = dirty.union_device_rects().expect("non-empty");
        assert_eq!((union.0, union.1, union.2, union.3), (0, 0, 100, 100));
        dirty.subtract((0, 0, 100, 100));
        assert!(dirty.is_empty());
        // Containment and duplicates collapse.
        dirty.add((0, 0, 10, 10));
        dirty.add((2, 2, 4, 4));
        assert_eq!(dirty.rects().len(), 1);
    }

    #[test]
    fn color_space_change_drops_residency_and_arms_clear() {
        let mut level = level();
        let id = ColorSpaceId::of(&None);
        level.set_current_color_space(id.clone());
        level.commit_tile([0, 0], surface(1), 1);
        assert!(!level.clear_before_upload());
        let other = ColorSpaceId::of(&Some(crate::color::ColorSettings::default()));
        assert!(!level.is_current_color_space_equal_to(&other));
        level.set_current_color_space(other);
        assert_eq!(level.tile_count(), 0);
        assert!(level.clear_before_upload());
    }

    #[test]
    fn find_writable_tile_returns_resident_surface() {
        let mut level = level();
        level.commit_tile([4, 4], surface(9), 2);
        assert!(level.find_writable_tile_at([4, 4]).is_some());
        assert_eq!(level.tile_count(), 0);
        assert!(level.find_writable_tile_at([5, 5]).is_none());
    }

    #[test]
    fn residency_is_budget_bounded() {
        let mut level = level();
        for column in 0..(LEVEL_TILE_LIMIT as i32 + 16) {
            level.commit_tile([column, 0], surface(1), 1);
        }
        assert_eq!(level.tile_count(), LEVEL_TILE_LIMIT);
        // The oldest tiles were evicted; the newest column is resident.
        assert!(level.tile(&[LEVEL_TILE_LIMIT as i32 + 15, 0]).is_some());
        assert!(level.tile(&[0, 0]).is_none());
    }

    #[test]
    fn panning_over_an_old_tile_refreshes_its_eviction_priority() {
        let mut level = level();
        for column in 0..LEVEL_TILE_LIMIT as i32 {
            level.commit_tile([column, 0], RasterSurface::new(1, 1), 1);
        }
        let queue = level.enqueue_renderable_tiles_for_visible_rect([0., 0., 512., 512.], 1).unwrap();
        assert!(queue.is_empty());
        level.commit_tile([LEVEL_TILE_LIMIT as i32, 0], RasterSurface::new(1, 1), 1);
        assert_eq!(level.tile_count(), LEVEL_TILE_LIMIT);
        assert!(level.tile(&[0, 0]).is_some());
        assert!(level.tile(&[1, 0]).is_none());
    }

    #[test]
    fn retire_tiles_below_drops_stale_content() {
        let mut level = level();
        level.commit_tile([0, 0], surface(1), 1);
        level.commit_tile([1, 0], surface(1), 3);
        level.retire_tiles_below(2);
        assert_eq!(level.resident_addresses(), vec![[1, 0]]);
    }
}
