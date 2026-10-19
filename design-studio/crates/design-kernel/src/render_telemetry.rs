//! Rendering telemetry — the counter that proves render count is not frame
//! count.
//!
//! Sketch's `MSRenderingTelemetry` (class-dump `SketchRendering_dump.txt`
//! lines 582–602) keeps `rasterisationStatistics` with `beginRasterisation
//! WithPixelCount:` / `endRasterisation` pairs, a parallel overlay stack, and
//! reports `rasterisationDuration:pixelCount:frameCount:overlayDuration:
//! overlayCount:` — five numbers in which rasterisation events and frames are
//! deliberately independent axes. This module is that contract: the tiled
//! renderer opens a rasterisation span per actual tile repaint (never per
//! presented frame), a frame counter advances on every composition, and the
//! ring buffer bounds memory exactly like `maxStatistics`.
//!
//! Wall-clock durations are optional: `std::time::Instant` does not exist on
//! the wasm target, so counts are always recorded and timing only where a
//! monotonic clock exists. Tests rely on counts alone.

/// One completed rasterisation span: how many device pixels were repainted
/// and, when a clock exists, how long the span took.
#[derive(Clone, Copy, Debug, Default)]
pub struct RasterStatistic {
    pub pixel_count: u64,
    pub duration_ms: Option<f64>,
}

/// One completed overlay rasterisation span (item count, not pixels —
/// overlays are vector items in the dump's model).
#[derive(Clone, Copy, Debug, Default)]
pub struct OverlayStatistic {
    pub item_count: u64,
    pub duration_ms: Option<f64>,
}

/// The reported telemetry snapshot, the fields of
/// `rasterisationDurationContainer:pixelCount:frameCount:overlayDuration:overlayCount:`.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryReport {
    pub rasterisation_count: u64,
    pub rasterisation_pixel_count: u64,
    pub rasterisation_duration_ms: Option<f64>,
    pub frame_count: u64,
    pub overlay_count: u64,
    pub overlay_item_count: u64,
    pub overlay_duration_ms: Option<f64>,
}

#[derive(Clone, Copy)]
struct RasterStart {
    pixel_count: u64,
    started: Option<f64>,
}

#[derive(Clone, Copy)]
struct OverlayStart {
    item_count: u64,
    started: Option<f64>,
}

/// Monotonic milliseconds where a clock exists; `None` on targets without
/// one (wasm32-unknown-unknown), where telemetry stays count-based.
fn monotonic_ms() -> Option<f64> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::sync::OnceLock;
        use std::time::Instant;
        static ANCHOR: OnceLock<Instant> = OnceLock::new();
        let anchor = ANCHOR.get_or_init(Instant::now);
        Some(anchor.elapsed().as_secs_f64() * 1000.)
    }
    #[cfg(target_arch = "wasm32")]
    {
        None
    }
}

pub struct RenderingTelemetry {
    rasterisation_statistics: std::collections::VecDeque<RasterStatistic>,
    max_statistics: usize,
    rasterisation_start_stack: Vec<RasterStart>,
    overlay_statistics: std::collections::VecDeque<OverlayStatistic>,
    overlay_start_stack: Vec<OverlayStart>,
    rasterisation_count_total: u64,
    overlay_count_total: u64,
    frame_count: u64,
}

impl Default for RenderingTelemetry {
    fn default() -> Self {
        RenderingTelemetry::new(32)
    }
}

impl RenderingTelemetry {
    /// `maxStatistics` bounds the retained statistics ring.
    pub fn new(max_statistics: usize) -> Self {
        RenderingTelemetry {
            rasterisation_statistics: std::collections::VecDeque::new(),
            max_statistics: max_statistics.max(1),
            rasterisation_start_stack: Vec::new(),
            overlay_statistics: std::collections::VecDeque::new(),
            overlay_start_stack: Vec::new(),
            rasterisation_count_total: 0,
            overlay_count_total: 0,
            frame_count: 0,
        }
    }

    /// `beginRasterisationWithPixelCount:` — open a span for one tile
    /// repaint of `pixel_count` device pixels.
    pub fn begin_rasterisation_with_pixel_count(&mut self, pixel_count: u64) {
        self.rasterisation_start_stack.push(RasterStart {
            pixel_count,
            started: monotonic_ms(),
        });
    }

    /// `endRasterisation` — close the innermost span and record it.
    pub fn end_rasterisation(&mut self) {
        let Some(start) = self.rasterisation_start_stack.pop() else {
            return;
        };
        self.rasterisation_count_total += 1;
        let statistic = RasterStatistic {
            pixel_count: start.pixel_count,
            duration_ms: match (start.started, monotonic_ms()) {
                (Some(begin), Some(end)) => Some((end - begin).max(0.)),
                _ => None,
            },
        };
        self.rasterisation_statistics.push_back(statistic);
        while self.rasterisation_statistics.len() > self.max_statistics {
            self.rasterisation_statistics.pop_front();
        }
    }

    /// Abandon any still-open spans (an error path must not leak a stack the
    /// next frame pairs with a stale begin).
    pub fn discard_open_rasterisations(&mut self) {
        self.rasterisation_start_stack.clear();
        self.overlay_start_stack.clear();
    }

    /// `beginOverlayRasterisationWithItemCount:`.
    pub fn begin_overlay_rasterisation_with_item_count(&mut self, item_count: u64) {
        self.overlay_start_stack.push(OverlayStart {
            item_count,
            started: monotonic_ms(),
        });
    }

    /// `endOverlayRasterisation`.
    pub fn end_overlay_rasterisation(&mut self) {
        let Some(start) = self.overlay_start_stack.pop() else {
            return;
        };
        self.overlay_count_total += 1;
        let statistic = OverlayStatistic {
            item_count: start.item_count,
            duration_ms: match (start.started, monotonic_ms()) {
                (Some(begin), Some(end)) => Some((end - begin).max(0.)),
                _ => None,
            },
        };
        self.overlay_statistics.push_back(statistic);
        while self.overlay_statistics.len() > self.max_statistics {
            self.overlay_statistics.pop_front();
        }
    }

    /// A frame was composited from tile content. This counter moves even
    /// when zero tiles rasterised — that asymmetry is the whole point of the
    /// telemetry.
    pub fn count_frame(&mut self) {
        self.frame_count += 1;
    }

    /// `reset`.
    pub fn reset(&mut self) {
        self.rasterisation_statistics.clear();
        self.overlay_statistics.clear();
        self.rasterisation_start_stack.clear();
        self.overlay_start_stack.clear();
        self.rasterisation_count_total = 0;
        self.overlay_count_total = 0;
        self.frame_count = 0;
    }

    /// `reportStatistics:` — totals over the retained ring plus the frame
    /// count. Totals are computed from the ring (bounded history), not from
    /// all-time counters, so a `reset` genuinely clears the report.
    pub fn report_statistics(&self) -> TelemetryReport {
        let mut report = TelemetryReport {
            frame_count: self.frame_count,
            ..TelemetryReport::default()
        };
        for statistic in &self.rasterisation_statistics {
            report.rasterisation_count += 1;
            report.rasterisation_pixel_count += statistic.pixel_count;
            if let (Some(duration), Some(total)) =
                (statistic.duration_ms, report.rasterisation_duration_ms.as_mut())
            {
                *total += duration;
            } else {
                report.rasterisation_duration_ms = None;
            }
        }
        for statistic in &self.overlay_statistics {
            report.overlay_count += 1;
            report.overlay_item_count += statistic.item_count;
            if let (Some(duration), Some(total)) =
                (statistic.duration_ms, report.overlay_duration_ms.as_mut())
            {
                *total += duration;
            } else {
                report.overlay_duration_ms = None;
            }
        }
        report
    }

    /// Rasterisation spans currently open (diagnostic for stall reports).
    pub fn open_rasterisation_spans(&self) -> usize {
        self.rasterisation_start_stack.len()
    }
}

// ---------------------------------------------------------------------------
// Figma engine memory telemetry axes — proto_telemetry_axes.txt offsets
// 840..872: `_totalGpuMemory` (840), `_texturesMemory` (848),
// `_vertexBuffersMemory` (856), `_renderBuffersMemory` (864),
// `_uniformBuffersMemory` (872).
//
// The evidence files do not close the binding between these five axes and
// the four CorePerfInfo ledger counters (VRAM-LEDGER-RESOLVED.md covers the
// counters; the axis slots are i32). The mapping below is by resource role
// and is recorded as an inference, with our four buckets
// (`memory::GpuMemoryCategory`) as the source of truth:
//
// | Figma axis              | our bucket        | Figma counter (inferred)      |
// |-------------------------|-------------------|-------------------------------|
// | texturesMemory          | Texture           | 5246784 texture bytes         |
// | vertexBuffersMemory     | FixedArray        | 5246800 countxcountx4 arrays  |
// | uniformBuffersMemory    | Buffer            | 5246792 lazy GPU buffers      |
// | renderBuffersMemory     | Blob              | 5246808 CPU-copied blobs      |
// | totalGpuMemory          | sum of all four   | #46443 renderer GPU total     |
//
// Units: we report bytes (u64). Figma's axis slots are i32 and its display
// strings use `>> 20` MB conversions, so the slots plausibly hold MB —
// unverified in the evidence; hosts convert as needed.
// ---------------------------------------------------------------------------

/// Figma's five GPU memory telemetry axes, derived from the kernel's
/// four-bucket GPU memory ledger.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FigmaGpuMemoryAxes {
    pub total_gpu_memory: u64,
    pub textures_memory: u64,
    pub vertex_buffers_memory: u64,
    pub render_buffers_memory: u64,
    pub uniform_buffers_memory: u64,
}

impl From<&crate::memory::GpuMemoryUsage> for FigmaGpuMemoryAxes {
    fn from(usage: &crate::memory::GpuMemoryUsage) -> Self {
        Self {
            textures_memory: usage.texture_bytes,
            vertex_buffers_memory: usage.fixed_array_bytes,
            uniform_buffers_memory: usage.buffer_bytes,
            render_buffers_memory: usage.blob_bytes,
            total_gpu_memory: usage.total_bytes(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_advance_without_rasterisation() {
        let mut telemetry = RenderingTelemetry::new(8);
        telemetry.count_frame();
        telemetry.count_frame();
        telemetry.count_frame();
        let report = telemetry.report_statistics();
        assert_eq!(report.frame_count, 3);
        assert_eq!(report.rasterisation_count, 0);
        assert_eq!(report.overlay_count, 0);
    }

    #[test]
    fn rasterisation_spans_record_pixels_independently_of_frames() {
        let mut telemetry = RenderingTelemetry::new(8);
        telemetry.begin_rasterisation_with_pixel_count(512 * 512);
        telemetry.end_rasterisation();
        telemetry.count_frame();
        telemetry.begin_rasterisation_with_pixel_count(512 * 256);
        telemetry.end_rasterisation();
        telemetry.begin_rasterisation_with_pixel_count(512 * 128);
        telemetry.end_rasterisation();
        telemetry.count_frame();
        let report = telemetry.report_statistics();
        assert_eq!(report.frame_count, 2);
        assert_eq!(report.rasterisation_count, 3);
        assert_eq!(
            report.rasterisation_pixel_count,
            (512u64 * 512 + 512 * 256 + 512 * 128)
        );
    }

    #[test]
    fn nested_spans_close_inner_first() {
        let mut telemetry = RenderingTelemetry::new(8);
        telemetry.begin_rasterisation_with_pixel_count(100);
        telemetry.begin_rasterisation_with_pixel_count(50);
        telemetry.end_rasterisation();
        assert_eq!(telemetry.open_rasterisation_spans(), 1);
        telemetry.end_rasterisation();
        assert_eq!(telemetry.open_rasterisation_spans(), 0);
        let report = telemetry.report_statistics();
        assert_eq!(report.rasterisation_pixel_count, 150);
        // End without begin is ignored, matching a defensive queue drain.
        telemetry.end_rasterisation();
        assert_eq!(telemetry.report_statistics().rasterisation_count, 2);
    }

    #[test]
    fn ring_is_bounded_and_reset_clears_everything() {
        let mut telemetry = RenderingTelemetry::new(2);
        for i in 0..5u64 {
            telemetry.begin_rasterisation_with_pixel_count(i + 1);
            telemetry.end_rasterisation();
        }
        let report = telemetry.report_statistics();
        assert_eq!(report.rasterisation_count, 2);
        assert_eq!(report.rasterisation_pixel_count, 4 + 5);
        telemetry.count_frame();
        telemetry.reset();
        let report = telemetry.report_statistics();
        assert_eq!(report, TelemetryReport::default());
    }

    #[test]
    fn overlay_axis_is_tracked_separately() {
        let mut telemetry = RenderingTelemetry::new(8);
        telemetry.begin_overlay_rasterisation_with_item_count(12);
        telemetry.end_overlay_rasterisation();
        telemetry.begin_rasterisation_with_pixel_count(64);
        telemetry.end_rasterisation();
        let report = telemetry.report_statistics();
        assert_eq!(report.overlay_count, 1);
        assert_eq!(report.overlay_item_count, 12);
        assert_eq!(report.rasterisation_count, 1);
        assert_eq!(report.frame_count, 0);
    }

    #[test]
    fn figma_gpu_memory_axes_map_the_four_ledger_buckets() {
        use crate::memory::{GpuMemoryCategory, GpuMemoryLedger};
        let ledger = GpuMemoryLedger::new(1 << 30);
        ledger.alloc(GpuMemoryCategory::Texture, 1 << 20);
        ledger.alloc(GpuMemoryCategory::FixedArray, 4096);
        ledger.alloc(GpuMemoryCategory::Buffer, 512);
        ledger.alloc(GpuMemoryCategory::Blob, 256);
        let axes = FigmaGpuMemoryAxes::from(&ledger.usage());
        assert_eq!(axes.textures_memory, 1 << 20);
        assert_eq!(axes.vertex_buffers_memory, 4096);
        assert_eq!(axes.uniform_buffers_memory, 512);
        assert_eq!(axes.render_buffers_memory, 256);
        assert_eq!(
            axes.total_gpu_memory,
            (1 << 20) + 4096 + 512 + 256,
            "total axis is the four-bucket sum (Figma #46443)"
        );
        // Peaks never leak into the gauge axes: they report live values.
        ledger.free(GpuMemoryCategory::Texture, 1 << 20);
        let axes = FigmaGpuMemoryAxes::from(&ledger.usage());
        assert_eq!(axes.textures_memory, 0);
        assert_eq!(axes.total_gpu_memory, 4096 + 512 + 256);
    }
}
