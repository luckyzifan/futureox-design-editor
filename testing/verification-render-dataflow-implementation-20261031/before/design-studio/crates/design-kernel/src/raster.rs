use crate::{
    math::{Point, Rect},
    path::Contour,
    render_cancellation::checkpoint,
};
use std::sync::Arc;
#[path = "raster_scan.rs"]
mod scan;
pub use scan::RasterWorkspace;

#[derive(Clone, Debug)]
pub struct Mask {
    pub rect: Rect,
    pub data: Vec<f32>,
}
impl Mask {
    pub fn at(&self, x: i32, y: i32) -> f32 {
        self.rect.index(x, y).map_or(0., |i| self.data[i])
    }
}

/// Four independent binary sample planes packed into one byte per pixel.
/// No averaging, UNORM conversion, paint quantization or HDR conversion occurs.
#[derive(Clone, Debug)]
pub struct SampleMasks {
    pub rect: Rect,
    data: Arc<Vec<u8>>,
}
impl SampleMasks {
    pub fn plane(&self, sample: usize) -> SamplePlane<'_> {
        assert!(sample < 4);
        SamplePlane {
            masks: self,
            sample,
        }
    }
    pub fn at(&self, sample: usize, x: i32, y: i32) -> f32 {
        assert!(sample < 4);
        self.rect
            .index(x, y)
            .map_or(0., |i| f32::from((self.data[i] >> sample) & 1))
    }
    pub fn storage_bytes(&self) -> usize {
        self.data.len()
    }
}

pub trait Coverage {
    fn rect(&self) -> Rect;
    fn at(&self, x: i32, y: i32) -> f32;
}
impl Coverage for Mask {
    fn rect(&self) -> Rect {
        self.rect
    }
    fn at(&self, x: i32, y: i32) -> f32 {
        self.at(x, y)
    }
}
pub struct SamplePlane<'a> {
    masks: &'a SampleMasks,
    sample: usize,
}
impl Coverage for SamplePlane<'_> {
    fn rect(&self) -> Rect {
        self.masks.rect
    }
    fn at(&self, x: i32, y: i32) -> f32 {
        self.masks.at(self.sample, x, y)
    }
}

fn validate_sample(sample: Option<usize>) -> Result<(), String> {
    if sample.is_some_and(|s| s >= 4) {
        Err("Invalid coverage sample".into())
    } else {
        Ok(())
    }
}

pub(crate) fn validate_points(cs: &[Contour]) -> Result<(), String> {
    for (i, p) in cs.iter().flat_map(|c| &c.points).enumerate() {
        if i % 256 == 0 {
            checkpoint()?;
        }
        if !p.finite() {
            return Err("Non-finite interval geometry".into());
        }
    }
    checkpoint()
}

/// Validate all input points, but only fillable contours contribute bounds.
/// Computing these together avoids a separate finite-point pass for CPU/GPU.
pub(crate) fn clipped_rect(cs: &[Contour], limit: Rect) -> Result<Rect, String> {
    checkpoint()?;
    clip_bounds(Rect::default(), limit)?;
    let mut min = Point::new(f64::INFINITY, f64::INFINITY);
    let mut max = Point::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
    for c in cs {
        checkpoint()?;
        let fillable = c.closed && c.points.len() >= 3;
        for (i, p) in c.points.iter().enumerate() {
            if i % 256 == 0 {
                checkpoint()?;
            }
            if !p.finite() {
                return Err("Non-finite interval geometry".into());
            }
            if fillable {
                min.x = min.x.min(p.x);
                min.y = min.y.min(p.y);
                max.x = max.x.max(p.x);
                max.y = max.y.max(p.y);
            }
        }
    }
    let bounds = if min.finite() {
        Rect::from_points([min, max].into_iter()).expand(1)
    } else {
        Rect::default()
    };
    clip_bounds(bounds, limit)
}

pub(crate) fn clip_bounds(bounds: Rect, limit: Rect) -> Result<Rect, String> {
    bounds
        .checked_intersect(limit)
        .ok_or_else(|| "Invalid interval geometry limit".into())
}

fn buffer<T: Default + Clone>(rect: Rect) -> Result<Vec<T>, String> {
    let len = (rect.w as usize)
        .checked_mul(rect.h as usize)
        .ok_or("Raster allocation overflow")?;
    let bytes = len
        .checked_mul(std::mem::size_of::<T>())
        .ok_or("Raster allocation overflow")?;
    // Same ceiling as the CPU compositor; production also accounts aggregate live buffers.
    if bytes > crate::memory::COMPOSITING_BYTES {
        return Err("Compositing memory budget exceeded".into());
    }
    checkpoint()?;
    let mut data = Vec::new();
    data.try_reserve_exact(len)
        .map_err(|_| "Raster allocation failed")?;
    // Bound cancellation latency even when initializing a large mask.
    while data.len() < len {
        checkpoint()?;
        data.resize((data.len() + 16384).min(len), T::default());
    }
    Ok(data)
}

/// Standard four-sample coverage, quantized to UNORM8 before paint.
/// For untrusted input use the fallible entry points below.
pub fn rasterize_msaa4(cs: &[Contour], limit: Rect, even_odd: bool) -> Mask {
    rasterize_sample(cs, limit, even_odd, None)
}
pub fn rasterize_sample(
    cs: &[Contour],
    limit: Rect,
    even_odd: bool,
    sample: Option<usize>,
) -> Mask {
    try_rasterize_sample(cs, limit, even_odd, sample).expect("Invalid raster geometry")
}
pub fn rasterize_sample_linear(
    cs: &[Contour],
    limit: Rect,
    even_odd: bool,
    sample: Option<usize>,
) -> Mask {
    try_rasterize_sample_linear(cs, limit, even_odd, sample).expect("Invalid raster geometry")
}
pub fn rasterize(cs: &[Contour], limit: Rect, even_odd: bool) -> Mask {
    try_rasterize(cs, limit, even_odd).expect("Invalid raster geometry")
}
pub fn try_rasterize_sample(
    cs: &[Contour],
    limit: Rect,
    even_odd: bool,
    sample: Option<usize>,
) -> Result<Mask, String> {
    RasterWorkspace::default().sample(cs, limit, even_odd, sample, true)
}
pub fn try_rasterize_sample_linear(
    cs: &[Contour],
    limit: Rect,
    even_odd: bool,
    sample: Option<usize>,
) -> Result<Mask, String> {
    RasterWorkspace::default().sample(cs, limit, even_odd, sample, false)
}
pub fn try_rasterize(cs: &[Contour], limit: Rect, even_odd: bool) -> Result<Mask, String> {
    RasterWorkspace::default().area(cs, limit, even_odd)
}

fn pixel_span(rect: Rect, row: u32, left: f64, right: f64) -> std::ops::Range<usize> {
    let sx = crate::fidelity::SAMPLE_OFFSETS[(row % 4) as usize].0;
    let start = ((left - sx).ceil() as i32).clamp(rect.x, rect.right());
    let end = ((right - sx).ceil() as i32).clamp(start, rect.right());
    let base = (row / 4) as usize * rect.w as usize;
    base + (start - rect.x) as usize..base + (end - rect.x) as usize
}

impl RasterWorkspace {
    pub fn samples(
        &mut self,
        cs: &[Contour],
        limit: Rect,
        even_odd: bool,
    ) -> Result<SampleMasks, String> {
        let rect = clipped_rect(cs, limit)?;
        let mut data = buffer::<u8>(rect)?;
        if !rect.empty() {
            self.sample_spans(cs, rect, even_odd, None, |row, l, r| {
                let bit = 1 << (row % 4);
                for chunk in data[pixel_span(rect, row, l, r)].chunks_mut(4096) {
                    checkpoint()?;
                    for value in chunk {
                        *value |= bit;
                    }
                }
                Ok(true)
            })?;
        }
        Ok(SampleMasks {
            rect,
            data: Arc::new(data),
        })
    }

    pub fn sample(
        &mut self,
        cs: &[Contour],
        limit: Rect,
        even_odd: bool,
        sample: Option<usize>,
        quantize: bool,
    ) -> Result<Mask, String> {
        validate_sample(sample)?;
        let rect = clipped_rect(cs, limit)?;
        let mut mask = Mask {
            rect,
            data: buffer(rect)?,
        };
        if rect.empty() {
            return Ok(mask);
        }
        self.sample_spans(cs, rect, even_odd, sample, |row, l, r| {
            for chunk in mask.data[pixel_span(rect, row, l, r)].chunks_mut(4096) {
                checkpoint()?;
                for value in chunk {
                    *value += if sample.is_some() { 1. } else { 0.25 };
                }
            }
            Ok(true)
        })?;
        // Individual planes are binary: quantization is an exact no-op.
        if quantize && sample.is_none() {
            for chunk in mask.data.chunks_mut(4096) {
                checkpoint()?;
                for value in chunk {
                    *value = (*value * 255.).round_ties_even() / 255.;
                }
            }
        }
        Ok(mask)
    }

    /// Eight vertical samples plus exact horizontal interval coverage.
    pub fn area(&mut self, cs: &[Contour], limit: Rect, even_odd: bool) -> Result<Mask, String> {
        let rect = clipped_rect(cs, limit)?;
        let mut mask = Mask {
            rect,
            data: buffer(rect)?,
        };
        if rect.empty() {
            return Ok(mask);
        }
        if let Some(bounds) = crate::coverage::rectangle(cs) {
            for y in
                rect.y.max(bounds[1].floor() as i32)..rect.bottom().min(bounds[3].ceil() as i32)
            {
                checkpoint()?;
                for x in
                    rect.x.max(bounds[0].floor() as i32)..rect.right().min(bounds[2].ceil() as i32)
                {
                    if (x - rect.x) % 4096 == 0 {
                        checkpoint()?;
                    }
                    let i = (y - rect.y) as usize * rect.w as usize + (x - rect.x) as usize;
                    mask.data[i] =
                        crate::coverage::rectangle_pixel(bounds, x as f64, y as f64) as f32;
                }
            }
            return Ok(mask);
        }
        self.area_spans(cs, rect, even_odd, |row, left, right| {
            for px in left.floor() as i32..right.ceil() as i32 {
                if (px - rect.x) % 4096 == 0 {
                    checkpoint()?;
                }
                if let Some(i) = rect.index(px, rect.y + (row / 8) as i32) {
                    let coverage =
                        (right.min(f64::from(px) + 1.) - left.max(f64::from(px))).max(0.) / 8.;
                    mask.data[i] += coverage as f32;
                }
            }
            Ok(true)
        })?;
        for chunk in mask.data.chunks_mut(4096) {
            checkpoint()?;
            for a in chunk {
                *a = a.clamp(0., 1.);
            }
        }
        Ok(mask)
    }
}

// Geometry-only consumers validate once before entering these scanners.
pub(crate) fn visit_sample_spans(
    cs: &[Contour],
    rect: Rect,
    even_odd: bool,
    sample: Option<usize>,
    mut emit: impl FnMut(u32, f64, f64) -> bool,
) -> Result<bool, String> {
    RasterWorkspace::default()
        .sample_spans(cs, rect, even_odd, sample, |row, l, r| Ok(emit(row, l, r)))
}
pub(crate) fn visit_spans(
    cs: &[Contour],
    rect: Rect,
    even_odd: bool,
    mut emit: impl FnMut(u32, f64, f64) -> bool,
) -> Result<bool, String> {
    RasterWorkspace::default().area_spans(cs, rect, even_odd, |row, l, r| Ok(emit(row, l, r)))
}
#[cfg(test)]
pub(crate) use scan::check_work;
#[cfg(test)]
#[path = "raster_bucket_tests.rs"]
mod bucket_tests;
