
use crate::device::RenderedFrame;
use futureox_design_kernel::tiled_renderer::UpdateStatus;
use futureox_design_kernel::{Engine, RenderOptions};
use serde::Serialize;
use std::time::Instant;

/// Honest counters for the host path, mirroring `TileCacheStats`' role.
#[derive(Clone, Debug, Default, Serialize)]
pub struct TiledHostStats {
    pub frames: usize,
    /// Frames served from tile residency without a single rasterisation.
    pub unchanged_frames: usize,
    pub tiles_rasterised: usize,
    pub tiles_cached: usize,
    /// Full-frame fallbacks: pixel preview or an unaligned camera.
    pub full_frames: usize,
    /// Legacy diagnostic counter. Settled host requests use their exact lattice.
    pub resampled_frames: usize,
    pub full_frame_reasons: Vec<&'static str>,
    pub raster_ms: f64,
    pub assemble_ms: f64,
    pub render_ms: f64,
}

pub struct TiledFrameHost {
    stats: TiledHostStats,
    /// Cumulative telemetry counter already booked into `stats` — the
    /// report's rasterisation axis is cumulative, the host books deltas.
    booked_rasterisation: u64,
}

impl Default for TiledFrameHost {
    fn default() -> Self {
        Self::new()
    }
}

impl TiledFrameHost {
    pub fn new() -> Self {
        TiledFrameHost {
            stats: TiledHostStats::default(),
            booked_rasterisation: 0,
        }
    }

    pub fn stats(&self) -> &TiledHostStats {
        &self.stats
    }

    /// Drop the kernel renderer state (device loss, document swap).
    pub fn clear(&mut self, engine: &mut Engine) {
        engine
            .tiled_renderer_mut()
            .remove_all_tiles_and_clear_dirty_regions();
        self.stats = TiledHostStats::default();
    }

    /// Render one frame through the kernel tiled renderer. `damage` is the
    /// world-space patch damage (`full` damage passes `None`).
    pub fn render(
        &mut self,
        engine: &mut Engine,
        options: &RenderOptions,
        damage: Option<&[[f64; 4]]>,
    ) -> Result<RenderedFrame, String> {
        let started = Instant::now();
        self.stats.frames += 1;
        if options.pixel_preview.is_some() {
            return self.full_frame(engine, options, "pixel preview", started);
        }
        let raster_started = Instant::now();
        let assembled = engine.render_tiled_frame(options, damage)?;
        if assembled.exact_viewport {
            self.stats.full_frames += 1;
            self.stats.full_frame_reasons.push("unaligned camera");
        }
        self.stats.raster_ms += raster_started.elapsed().as_secs_f64() * 1000.;
        match assembled.status {
            UpdateStatus::NoChange => self.stats.unchanged_frames += 1,
            _ => {}
        }
        let assemble_started = Instant::now();
        let rgba = assembled.rgba;
        self.stats.assemble_ms += assemble_started.elapsed().as_secs_f64() * 1000.;
        let rasterised_delta =
            (assembled.telemetry.rasterisation_count - self.booked_rasterisation) as usize;
        self.booked_rasterisation = assembled.telemetry.rasterisation_count;
        self.stats.tiles_rasterised += rasterised_delta;
        self.stats.tiles_cached += assembled.visible_tiles.saturating_sub(rasterised_delta);
        let render_ms = started.elapsed().as_secs_f64() * 1000.;
        self.stats.render_ms += render_ms;
        Ok(RenderedFrame {
            width: options.width,
            height: options.height,
            rgba,
            linear: None,
            draw_calls: 0,
            submissions: 0,
            peak_texture_bytes: 0,
            render_ms,
            encode_ms: 0.,
            readback_ms: 0.,
        })
    }

    fn full_frame(
        &mut self,
        engine: &mut Engine,
        options: &RenderOptions,
        reason: &'static str,
        started: Instant,
    ) -> Result<RenderedFrame, String> {
        self.stats.full_frames += 1;
        self.stats.full_frame_reasons.push(reason);
        let rgba = engine.render(options)?;
        let render_ms = started.elapsed().as_secs_f64() * 1000.;
        self.stats.render_ms += render_ms;
        Ok(RenderedFrame {
            width: options.width,
            height: options.height,
            rgba,
            linear: None,
            draw_calls: 0,
            submissions: 0,
            peak_texture_bytes: 0,
            render_ms,
            encode_ms: 0.,
            readback_ms: 0.,
        })
    }
}
