//! Owned raster surfaces and their bounded reuse pool.

use std::collections::VecDeque;
use std::sync::Arc;

/// A CPU-rasterised tile surface: `width * height` premultiplied RGBA8
/// bytes, row-major with `width * 4` bytes per row.
#[derive(Clone)]
pub struct RasterSurface {
    width: u32,
    height: u32,
    bytes: Arc<Vec<u8>>,
}

impl RasterSurface {
    pub fn new(width: u32, height: u32) -> Self {
        RasterSurface {
            width,
            height,
            bytes: Arc::new(vec![0; Self::byte_len(width, height)]),
        }
    }

    fn byte_len(width: u32, height: u32) -> usize {
        width as usize * height as usize * 4
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Byte length of the surface (`width * height * 4`).
    pub fn stored_bytes(&self) -> usize {
        self.bytes.len()
    }

    /// Share the pixel bytes without copying — the zero-copy hand-off the
    /// compositor gets from `metalTextureForRenderer:` on the IOSurface side.
    pub fn share_bytes(&self) -> Arc<Vec<u8>> {
        Arc::clone(&self.bytes)
    }

    pub fn into_arc(self) -> Arc<Vec<u8>> {
        self.bytes
    }

    /// `MSTile.replaceRegion:withBytes:bytesPerRow:` — overwrite one
    /// sub-rectangle from a freshly rasterised byte stream. Regions are
    /// clamped to the surface; a region that lands outside entirely is a
    /// no-op, matching how a GPU `replaceRegion` on a texture behaves.
    pub fn replace_region(
        &mut self,
        region: (i32, i32, u32, u32),
        source: &[u8],
        bytes_per_row: usize,
    ) -> Result<(), String> {
        let (x, y, w, h) = region;
        if w == 0 || h == 0 {
            return Ok(());
        }
        if x >= self.width as i32
            || y >= self.height as i32
            || x + w as i32 <= 0
            || y + h as i32 <= 0
        {
            return Ok(());
        }
        // Copy-on-write keeps shared surfaces intact when a tile is resident
        // in two levels while one of them takes a partial update. Clipping
        // maps every written pixel back to its region row/column so a
        // negative-origin region reads the bytes it visually corresponds to.
        let destination = Arc::make_mut(&mut self.bytes);
        let x0 = x.max(0) as usize;
        let y0 = y.max(0) as usize;
        let x1 = (x + w as i32).min(self.width as i32) as usize;
        let y1 = (y + h as i32).min(self.height as i32) as usize;
        let columns = x1 - x0;
        for row in y0..y1 {
            let region_row = (row as i64 - i64::from(y)) as usize;
            let region_column = (x0 as i64 - i64::from(x)) as usize;
            let src = region_row
                .checked_mul(bytes_per_row)
                .and_then(|offset| offset.checked_add(region_column * 4))
                .ok_or("Tile region offset overflow")?;
            let src_end = src
                .checked_add(columns * 4)
                .ok_or("Tile region offset overflow")?;
            if src_end > source.len() {
                return Err("Tile byte stream shorter than its region".into());
            }
            let dst = row * self.width as usize * 4 + x0 * 4;
            destination[dst..dst + columns * 4].copy_from_slice(&source[src..src_end]);
        }
        Ok(())
    }

    /// `MSTile.blitFromSourceTexture:sourceTextureRect:pointInDestinationTexture:commands:`
    /// — copy an already-rasterised pixel region from another surface
    /// instead of re-rendering it. Same-resolution copy only (the GPU blit
    /// has no filter); resampling across scales belongs to the compositor.
    pub fn blit_from(
        &mut self,
        source: &RasterSurface,
        source_rect: (i32, i32, u32, u32),
        destination: (i32, i32),
    ) -> Result<(), String> {
        let (sx, sy, sw, sh) = source_rect;
        if sw == 0 || sh == 0 {
            return Ok(());
        }
        if sx < 0
            || sy < 0
            || sx + sw as i32 > source.width as i32
            || sy + sh as i32 > source.height as i32
        {
            return Err("Blit source rectangle outside the source surface".into());
        }
        let dx0 = destination.0.max(0) as usize;
        let dy0 = destination.1.max(0) as usize;
        let dx1 = (destination.0 + sw as i32).min(self.width as i32) as usize;
        let dy1 = (destination.1 + sh as i32).min(self.height as i32) as usize;
        if dx0 >= dx1 || dy0 >= dy1 {
            return Ok(());
        }
        let bytes = Arc::make_mut(&mut self.bytes);
        for row in dy0..dy1 {
            let src = ((sy as usize) + (row - dy0)) * source.width as usize * 4
                + sx as usize * 4;
            let dst = row * self.width as usize * 4 + dx0 * 4;
            let span = (dx1 - dx0) * 4;
            bytes[dst..dst + span]
                .copy_from_slice(&source.bytes[src..src + span]);
        }
        Ok(())
    }
}

pub struct RasterSurfacePool {
    idle: VecDeque<RasterSurface>,
    idle_bytes: usize,
    budget_bytes: usize,
    outstanding_bytes: usize,
    peak_outstanding_bytes: usize,
    total_vended: usize,
    total_recycled: usize,
}

impl Default for RasterSurfacePool {
    fn default() -> Self {
        RasterSurfacePool::new(256 * 1024 * 1024)
    }
}

impl RasterSurfacePool {
    pub fn new(budget_bytes: usize) -> Self {
        RasterSurfacePool {
            idle: VecDeque::new(),
            idle_bytes: 0,
            budget_bytes,
            outstanding_bytes: 0,
            peak_outstanding_bytes: 0,
            total_vended: 0,
            total_recycled: 0,
        }
    }

    /// Take a surface from the pool, allocating only when the idle queue has
    /// no match and the byte budget allows. Budget exhaustion is not an
    /// error — the caller degrades to direct allocation so rendering never
    /// stops because a pool is full.
    pub fn vend(&mut self, width: u32, height: u32) -> RasterSurface {
        let needed = RasterSurface::byte_len(width, height);
        self.total_vended += 1;
        if let Some(index) = self
            .idle
            .iter()
            .position(|s| s.width == width && s.height == height)
        {
            let surface = self.idle.remove(index).expect("index just found");
            self.idle_bytes -= surface_byte_len(&surface);
            self.outstanding_bytes += needed;
            self.peak_outstanding_bytes = self.peak_outstanding_bytes.max(self.outstanding_bytes);
            return surface;
        }
        self.outstanding_bytes += needed;
        self.peak_outstanding_bytes = self.peak_outstanding_bytes.max(self.outstanding_bytes);
        RasterSurface::new(width, height)
    }

    /// Return a surface for reuse (`recycleContext:`).
    pub fn recycle(&mut self, surface: RasterSurface) {
        let bytes = surface_byte_len(&surface);
        self.outstanding_bytes = self.outstanding_bytes.saturating_sub(bytes);
        self.total_recycled += 1;
        if self.idle_bytes + bytes <= self.budget_bytes {
            self.idle_bytes += bytes;
            self.idle.push_back(surface);
        }
    }

    /// `removeAllObjects` — drop every idle surface.
    pub fn remove_all_objects(&mut self) {
        self.idle.clear();
        self.idle_bytes = 0;
    }

    pub fn idle_count(&self) -> usize {
        self.idle.len()
    }

    pub fn outstanding_bytes(&self) -> usize {
        self.outstanding_bytes
    }

    pub fn peak_outstanding_bytes(&self) -> usize {
        self.peak_outstanding_bytes
    }

    pub fn total_vended(&self) -> usize {
        self.total_vended
    }

    pub fn total_recycled(&self) -> usize {
        self.total_recycled
    }
}

fn surface_byte_len(surface: &RasterSurface) -> usize {
    RasterSurface::byte_len(surface.width, surface.height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_region_writes_only_the_requested_rectangle() {
        let mut surface = RasterSurface::new(4, 4);
        let bytes: Vec<u8> = (0..2u32 * 2 * 4).map(|i| (i % 251) as u8).collect();
        surface
            .replace_region((1, 1, 2, 2), &bytes, 2 * 4)
            .expect("in-bounds region");
        for y in 0..4 {
            for x in 0..4 {
                let index = (y * 4 + x) * 4;
                let inside = (1..3).contains(&x) && (1..3).contains(&y);
                let expected = if inside {
                    let local = ((y - 1) * 2 + (x - 1)) * 4;
                    bytes[local]
                } else {
                    0
                };
                assert_eq!(surface.bytes()[index], expected, "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn replace_region_clamps_and_rejects_short_streams() {
        let mut surface = RasterSurface::new(2, 2);
        surface
            .replace_region((-1, -1, 4, 4), &[0u8; 4 * 4 * 4], 4 * 4)
            .expect("clamped region");
        assert!(surface.bytes().iter().all(|&b| b == 0));
        assert!(surface
            .replace_region((0, 0, 2, 2), &[0u8; 4], 2 * 4)
            .is_err());
        // Entirely outside is a no-op, not an error.
        surface
            .replace_region((8, 8, 1, 1), &[0u8; 4], 4)
            .expect("outside region is a no-op");
    }

    #[test]
    fn blit_copies_regions_between_surfaces() {
        let mut source = RasterSurface::new(4, 4);
        let fill: Vec<u8> = (0..16u32 * 4).map(|i| (i % 251) as u8).collect();
        source
            .replace_region((0, 0, 4, 4), &fill, 4 * 4)
            .expect("full region");
        let mut destination = RasterSurface::new(4, 4);
        destination
            .blit_from(&source, (1, 1, 2, 2), (2, 2))
            .expect("same-resolution blit");
        for row in 0..2 {
            for column in 0..2 {
                let src = ((1 + row) * 4 + 1 + column) * 4;
                let dst = ((2 + row) * 4 + 2 + column) * 4;
                assert_eq!(
                    &source.bytes()[src..src + 4],
                    &destination.bytes()[dst..dst + 4]
                );
            }
        }
        // Outside the blit destination the surface stays untouched.
        assert!(destination.bytes()[..8].iter().all(|&b| b == 0));
        assert!(destination
            .blit_from(&source, (3, 3, 2, 2), (0, 0))
            .is_err());
    }

    #[test]
    fn pool_recycles_surfaces_of_matching_geometry() {
        let mut pool = RasterSurfacePool::new(4 * 1024 * 1024);
        let first = pool.vend(512, 512);
        let second = pool.vend(512, 512);
        pool.recycle(first);
        let third = pool.vend(512, 512);
        assert_eq!(pool.total_recycled(), 1);
        assert_eq!(third.width(), 512);
        pool.recycle(second);
        pool.recycle(third);
        assert_eq!(pool.idle_count(), 2);
        pool.remove_all_objects();
        assert_eq!(pool.idle_count(), 0);
    }

    #[test]
    fn pool_budget_caps_idle_bytes_but_never_fails() {
        let mut pool = RasterSurfacePool::new(512 * 512 * 4);
        let a = pool.vend(512, 512);
        let b = pool.vend(512, 512);
        pool.recycle(a);
        pool.recycle(b);
        assert_eq!(pool.idle_count(), 1, "second recycle exceeds the budget");
        // A vend past budget still succeeds by allocating directly.
        let _ = pool.vend(512, 512);
        let _ = pool.vend(512, 512);
        let _ = pool.vend(512, 512);
    }

    #[test]
    fn shared_surfaces_copy_on_write() {
        let mut a = RasterSurface::new(2, 2);
        let snapshot = a.clone();
        let bytes: Vec<u8> = vec![9; 16];
        a.replace_region((0, 0, 2, 2), &bytes, 8).expect("region");
        assert!(snapshot.bytes().iter().all(|&b| b == 0));
        assert!(a.bytes().iter().all(|&b| b == 9));
    }
}
