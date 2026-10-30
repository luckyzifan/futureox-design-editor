//! Integration tests for the Sketch-parity tiled renderer
//! (`MSTiledRenderer` architecture): instruction-equality skipping, pan and
//! damage reuse, parallel-vs-sequential byte identity, mip-level switching
//! and the rasterisation/frame telemetry axes.

use futureox_design_kernel::render_instruction::{
    ColorSpaceId, InstructionOptions, RenderInstruction,
};
use futureox_design_kernel::render_telemetry::RenderingTelemetry;
use futureox_design_kernel::tiled_renderer::{
    PresentDecision, RenderFeatureFlags, TileRasterSource, TileRasterizer, TiledRenderer,
    UpdateStatus,
};
use futureox_design_kernel::tile_stack::{exact_bucket_scale, TILE_SIZE};
use futureox_design_kernel::{Engine, RenderOptions, View};
use std::sync::Arc;
use serde_json::json;

fn doc() -> String {
    json!({
        "schemaVersion": 1,
        "id": "d",
        "name": "tiled",
        "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
        "nodes": {"r": {
            "id": "r",
            "kind": "rectangle",
            "transform": [1, 0, 0, 1, 16., 16.],
            "width": 640.,
            "height": 640.,
            "fills": [{"kind": "solid", "color": "#3366aa"}]
        }}
    })
    .to_string()
}

fn frame(view: View, width: u32, height: u32) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width,
        height,
        view,
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}

fn instruction(engine: &Engine, viewport: [f64; 4], zoom: f64) -> RenderInstruction {
    RenderInstruction {
        page_id: "p".into(),
        viewport,
        zoom,
        level_scale: exact_bucket_scale(zoom),
        backing_scale: 1.,
        content_revision: engine.content_revision(),
        options: InstructionOptions::new(false, false, "analytic"),
        color_space: ColorSpaceId::of(&engine.color_settings()),
    }
}

/// A counting raster source: real engine rasterisation plus call accounting
/// shared with spawned workers, so parallel rasterisation counts too.
struct CountingSource {
    engine: Engine,
    rasterized: Arc<std::sync::atomic::AtomicUsize>,
    prepared: usize,
}

impl CountingSource {
    fn new(engine: Engine) -> Self {
        CountingSource {
            engine,
            rasterized: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            prepared: 0,
        }
    }

    fn rasterized(&self) -> usize {
        self.rasterized.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl TileRasterizer for CountingSource {
    fn rasterize_tile(
        &mut self,
        request: &futureox_design_kernel::tiled_renderer::TileRequest,
    ) -> Result<Vec<u8>, String> {
        self.rasterized
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.engine.rasterize_tile(request)
    }
}

impl TileRasterSource for CountingSource {
    fn content_revision(&self) -> u64 {
        self.engine.content_revision()
    }

    fn prepare(&mut self, options: &RenderOptions) -> Result<(), String> {
        self.prepared += 1;
        self.engine.prepare(options)
    }

    fn spawn_worker(&self) -> Option<Box<dyn TileRasterizer + Send>> {
        struct CountingWorker {
            inner: Box<dyn TileRasterizer + Send>,
            rasterized: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl TileRasterizer for CountingWorker {
            fn rasterize_tile(
                &mut self,
                request: &futureox_design_kernel::tiled_renderer::TileRequest,
            ) -> Result<Vec<u8>, String> {
                self.rasterized
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.inner.rasterize_tile(request)
            }
        }
        self.engine.spawn_worker().map(|inner| {
            Box::new(CountingWorker {
                inner,
                rasterized: Arc::clone(&self.rasterized),
            }) as Box<dyn TileRasterizer + Send>
        })
    }
}

#[test]
fn equal_instruction_rasterises_nothing() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 1024);
    let first = instruction(&source.engine, [0., 0., 1024., 1024.], 1.);
    let mut renderer = TiledRenderer::default();
    let status = renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("first update");
    assert_eq!(status, UpdateStatus::Completed);
    assert!(source.rasterized() > 0, "cold frame rasterises its tiles");
    let cold_tiles = source.rasterized();

    // Identical instruction: no queue, no raster, no prepare.
    let status = renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("repeat update");
    assert_eq!(status, UpdateStatus::NoChange);
    assert_eq!(source.rasterized(), cold_tiles);
    assert_eq!(source.prepared, 1, "prepare runs once for the cold frame");

    // Present decision agrees, and composited frames advance telemetry
    // without touching rasterisation spans.
    renderer.note_composited(&first);
    renderer.note_composited(&first);
    let report = renderer.telemetry().report_statistics();
    assert_eq!(report.frame_count, 2);
    assert_eq!(report.rasterisation_count as usize, cold_tiles);
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&first, false, false),
        PresentDecision::PresentComposited
    );
}

#[test]
fn pan_rasterises_only_newly_exposed_tiles() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let left = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let first = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    renderer
        .update_with_instruction(&mut source, &left, &first, None)
        .expect("cold frame");
    assert_eq!(source.rasterized(), 1, "512px viewport covers one tile");

    // Pan right by exactly one tile: the resident tile stays, one new tile
    // rasterises.
    let right = frame(View { x: -512., y: 0., zoom: 1. }, 512, 512);
    let panned = instruction(&source.engine, [512., 0., 512., 512.], 1.);
    let status = renderer
        .update_with_instruction(&mut source, &right, &panned, None)
        .expect("pan update");
    assert_eq!(status, UpdateStatus::Completed);
    assert_eq!(source.rasterized(), 2, "pan rasterises only the exposed tile");
    assert!(renderer.level(3).is_some());
    assert_eq!(
        renderer.level(3).expect("level one").tile_count(),
        2,
        "both tiles stay resident"
    );
}

#[test]
fn damage_rasterises_only_dirty_tiles() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 512);
    let first = instruction(&source.engine, [0., 0., 1024., 512.], 1.);
    renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("cold frame");
    assert_eq!(source.rasterized(), 2);

    // Edit: the engine installs a new document revision; damage covers only
    // the right half of the canvas.
    source
        .engine
        .load_document(
            &json!({
                "schemaVersion": 1,
                "id": "d",
                "name": "tiled",
                "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
                "nodes": {"r": {
                    "id": "r",
                    "kind": "rectangle",
                    "transform": [1, 0, 0, 1, 560., 16.],
                    "width": 320.,
                    "height": 320.,
                    "fills": [{"kind": "solid", "color": "#aa6633"}]
                }}
            })
            .to_string(),
        )
        .expect("patched document");
    let edited = instruction(&source.engine, [0., 0., 1024., 512.], 1.);
    let damage = [[520., 0., 400., 512.]];
    let status = renderer
        .update_with_instruction(&mut source, &options, &edited, Some(&damage))
        .expect("damage update");
    assert_eq!(status, UpdateStatus::Completed);
    assert_eq!(
        source.rasterized(), 3,
        "only the dirty right-hand tile re-rasterises"
    );
}

#[test]
fn zoom_bucket_switch_records_previous_level() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let zoomed_out = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let first = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    renderer
        .update_with_instruction(&mut source, &zoomed_out, &first, None)
        .expect("cold frame");
    assert!(renderer.previous_level().is_none());

    // Zoom in across a bucket boundary (1 -> 2): the new level owns content,
    // the previous level stays recorded for upscaled display.
    let zoomed_in = frame(View { x: 0., y: 0., zoom: 1.4 }, 512, 512);
    let second = instruction(&source.engine, [0., 0., 512., 512.], 1.4);
    assert_eq!(second.level_scale, 2., "1.4 rasterises at bucket 2");
    renderer
        .update_with_instruction(&mut source, &zoomed_in, &second, None)
        .expect("zoom update");
    assert_eq!(renderer.previous_level(), Some(3), "level one stays previous");
    assert!(renderer.level(4).is_some(), "level two exists");
    // Zoom inside the new bucket: no ZOOM_BUCKET change, no re-raster.
    let same_bucket = frame(View { x: 0., y: 0., zoom: 1.6 }, 512, 512);
    let third = instruction(&source.engine, [0., 0., 512., 512.], 1.6);
    let tiles_before = source.rasterized();
    let status = renderer
        .update_with_instruction(&mut source, &same_bucket, &third, None)
        .expect("in-bucket zoom");
    assert_eq!(status, UpdateStatus::NoChange);
    assert_eq!(source.rasterized(), tiles_before);
}

#[test]
fn parallel_rasterisation_matches_sequential_bytes() {
    let mut sequential_engine = Engine::new();
    sequential_engine.load_document(&doc()).expect("document");
    let mut parallel_engine = Engine::new();
    parallel_engine.load_document(&doc()).expect("document");

    let viewport = [0., 0., 2048., 1024.];
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 2048, 1024);

    let mut sequential_source = CountingSource::new(sequential_engine);
    let mut sequential = TiledRenderer::new(RenderFeatureFlags {
        rasterize_concurrently: false,
        ..RenderFeatureFlags::default()
    });
    let sequential_instruction = instruction(&sequential_source.engine, viewport, 1.);
    sequential
        .update_with_instruction(&mut sequential_source, &options, &sequential_instruction, None)
        .expect("sequential update");

    let mut parallel_source = CountingSource::new(parallel_engine);
    let mut parallel = TiledRenderer::new(RenderFeatureFlags {
        rasterize_concurrently: true,
        worker_limit: Some(4),
        ..RenderFeatureFlags::default()
    });
    let parallel_instruction = instruction(&parallel_source.engine, viewport, 1.);
    parallel
        .update_with_instruction(&mut parallel_source, &options, &parallel_instruction, None)
        .expect("parallel update");

    assert_eq!(sequential_source.rasterized(), 8, "2048x1024 covers 8 tiles");
    assert_eq!(parallel_source.rasterized(), 8);
    let level = 3;
    let sequential_level = sequential.level(level).expect("sequential level");
    let parallel_level = parallel.level(level).expect("parallel level");
    for address in sequential_level.resident_addresses() {
        let a = sequential_level
            .tile(&address)
            .expect("sequential tile")
            .surface
            .bytes();
        let b = parallel_level
            .tile(&address)
            .expect("parallel tile")
            .surface
            .bytes();
        assert_eq!(a, b, "tile {address:?} bytes must be scheduling-independent");
    }
}

#[test]
fn tile_bytes_equal_direct_device_rect_render() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let first = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("cold frame");
    let tile = renderer
        .level(3)
        .and_then(|level| level.tile(&[0, 0]))
        .expect("resident tile");
    let direct = source
        .engine
        .render_device_rect(&options, 0, 0, 512, 512)
        .expect("direct render");
    assert_eq!(tile.surface.bytes(), direct.as_slice());
    assert_eq!(tile.surface.bytes().len(), 512 * 512 * 4);
}

/// The camera-contract regression test: a panned camera (non-zero view) over
/// non-origin tile addresses must assemble the same bytes as a full render.
/// The historical sign errors — instruction viewport, per-tile camera, and
/// the assembly translation — each cancel or hide at view = 0, which is why
/// every earlier equality test sat at the origin.
#[test]
fn panned_tiled_frame_assembly_equals_full_render() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let options = frame(View { x: -512., y: -256., zoom: 1. }, 1024, 768);
    let full = engine.render(&options).expect("full render");
    let assembled = engine
        .render_tiled_frame(&options, None)
        .expect("tiled frame");
    assert_eq!(assembled.level_scale, 1.);
    assert!(
        engine
            .tiled_renderer()
            .and_then(|r| r.level(3))
            .is_some_and(|level| level.tile(&[1, 0]).is_some() || level.tile(&[2, 0]).is_some()),
        "the pan must reach non-origin addresses"
    );
    assert_eq!(
        assembled.rgba, full,
        "panned tiled assembly must equal the full render"
    );
    // A mid-tile pan (view not a tile multiple) clips every tile at the
    // viewport edge — the case whose missing source-column offset once
    // shifted the whole blit.
    let mid = frame(View { x: -576., y: -288., zoom: 1. }, 1024, 768);
    let mid_full = engine.render(&mid).expect("mid-tile full render");
    let mid_assembled = engine
        .render_tiled_frame(&mid, None)
        .expect("mid-tile tiled frame");
    assert_eq!(
        mid_assembled.rgba, mid_full,
        "mid-tile pan assembly must equal the full render"
    );
}

/// An off-bucket zoom (0.9, bucket 1.0) assembles from residency instead of
/// taking a full-frame path, and an in-bucket zoom change re-identifies the
/// resident tiles so nothing re-rasterises — the drawTiles tier of fidelity.
#[test]
fn off_bucket_zoom_assembles_from_residency() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let options = frame(View { x: 0., y: 0., zoom: 0.9 }, 512, 384);
    let cold = engine.render_tiled_frame(&options, None).expect("cold frame");
    assert_eq!(cold.level_scale, 1., "0.9 rasterises at bucket 1.0");
    assert_eq!(cold.rgba.len(), 512 * 384 * 4);
    let cold_rasterised = cold.telemetry.rasterisation_count as usize;
    assert!(cold_rasterised > 0, "the cold frame rasterises its tiles");
    // Zoom out inside the same bucket: the viewport shrinks onto residency.
    let zoomed = frame(View { x: 0., y: 0., zoom: 0.85 }, 512, 384);
    let warm = engine
        .render_tiled_frame(&zoomed, None)
        .expect("in-bucket frame");
    assert_eq!(warm.level_scale, 1.);
    assert_eq!(
        warm.telemetry.rasterisation_count as usize, cold_rasterised,
        "an in-bucket zoom change must not re-rasterise a single tile"
    );
}

/// The resampled assembly stays close to a direct render at the same zoom:
/// constant regions reproduce exactly and only the neighbourhood of content
/// edges moves — never a wholesale pixel drift.
#[test]
fn off_bucket_assembly_stays_close_to_direct_render() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let options = frame(View { x: 0., y: 0., zoom: 0.9 }, 512, 384);
    let direct = engine.render(&options).expect("direct render");
    let assembled = engine
        .render_tiled_frame(&options, None)
        .expect("assembled frame");
    assert_eq!(assembled.rgba.len(), direct.len());
    let mut differing = 0usize;
    let mut strongly_differing = 0usize;
    for (a, b) in assembled.rgba.chunks_exact(4).zip(direct.chunks_exact(4)) {
        let delta = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| x.abs_diff(*y))
            .max()
            .unwrap_or(0);
        if delta > 0 {
            differing += 1;
        }
        if delta > 60 {
            strongly_differing += 1;
        }
    }
    let total = 512 * 384;
    assert!(
        (differing as f64 / total as f64) < 0.06,
        "constant regions must reproduce exactly ({differing}/{total} differ)"
    );
    assert!(
        (strongly_differing as f64 / total as f64) < 0.01,
        "only content-edge neighbourhoods may move strongly ({strongly_differing}/{total})"
    );
    // Deep-interior probe points: solid fill and page background are exact.
    for (x, y) in [(200usize, 200usize), (60usize, 60usize), (400usize, 300usize)] {
        let i = (y * 512 + x) * 4;
        assert_eq!(
            &assembled.rgba[i..i + 4],
            &direct[i..i + 4],
            "interior pixel ({x},{y}) must be byte-exact"
        );
    }
}

/// Returning to the bucket scale after an off-bucket zoom lands back on the
/// byte-exact blit — the resample tier never contaminates the parity contract.
#[test]
fn bucket_zoom_after_off_bucket_is_byte_exact() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let off_bucket = frame(View { x: -64., y: -32., zoom: 0.9 }, 512, 384);
    engine
        .render_tiled_frame(&off_bucket, None)
        .expect("off-bucket frame");
    let snapped = frame(View { x: -64., y: -32., zoom: 1. }, 512, 384);
    let assembled = engine
        .render_tiled_frame(&snapped, None)
        .expect("snapped frame");
    let direct = engine.render(&snapped).expect("direct render");
    assert_eq!(assembled.rgba, direct, "snapped zoom must stay byte-exact");
}

/// Residency outside the current viewport must not ride along in the payload:
/// hosts blit every listed tile at its world position, so history tiles would
/// ghost over the canvas forever.
#[test]
fn tiled_payload_lists_only_viewport_tiles() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    // Fill residency around the origin first.
    let origin = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 1024);
    engine.update_tiled_frame(&origin, None).expect("origin frame");
    // Pan far away: the origin tiles stay resident but must not be listed.
    let panned = frame(View { x: -4096., y: -4096., zoom: 1. }, 512, 512);
    let frame = engine.update_tiled_frame(&panned, None).expect("panned frame");
    assert!(
        frame.tiles.iter().all(|t| t.world[0] >= 3584. && t.world[1] >= 3584.),
        "payload stays inside the panned viewport"
    );
    assert!(
        engine.tiled_renderer().expect("renderer").resident_tile_count() > frame.tiles.len(),
        "origin residency survives for a pan back"
    );
}

#[test]
fn stale_source_revision_is_rejected() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let mut stale = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    stale.content_revision += 1;
    let error = renderer
        .update_with_instruction(&mut source, &options, &stale, None)
        .expect_err("mismatched revision");
    assert!(error.contains("revision"), "error names the mismatch: {error}");
}

#[test]
fn first_frame_presents_composited_even_without_sync_request() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let pending = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    // Nothing rendered yet and no composited frame exists: the semaphore
    // forces composited presentation (`forceSyncFirstFrame`).
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&pending, false, false),
        PresentDecision::PresentComposited
    );
    // A mid-raster camera change on a later frame may fall back to the
    // previous level when nobody waits synchronously.
    renderer.note_composited(&pending);
    let mut next = pending.clone();
    next.viewport = [0., 512., 512., 512.];
    let _ = next.viewport; // still unrendered content
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&next, false, false),
        PresentDecision::PresentPreviousLevel
    );
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&next, true, false),
        PresentDecision::PresentComposited,
        "synchronous waits must complete"
    );
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&next, false, true),
        PresentDecision::PresentComposited,
        "user focus must not present stale content"
    );
}

#[test]
fn telemetry_separates_rasterisation_from_frames() {
    let mut telemetry = RenderingTelemetry::new(16);
    for _ in 0..3 {
        telemetry.begin_rasterisation_with_pixel_count(512 * 512);
        telemetry.end_rasterisation();
    }
    telemetry.count_frame();
    telemetry.count_frame();
    let report = telemetry.report_statistics();
    assert_eq!(report.rasterisation_count, 3);
    assert_eq!(report.frame_count, 2);
}

#[test]
fn remove_all_tiles_clears_residency_everywhere() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 1024);
    let first = instruction(&source.engine, [0., 0., 1024., 1024.], 1.);
    renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("cold frame");
    assert_eq!(renderer.resident_tile_count(), 4);
    renderer.remove_all_tiles_and_clear_dirty_regions();
    assert_eq!(renderer.resident_tile_count(), 0);
    assert_eq!(
        TILE_SIZE, 512,
        "tile geometry matches the kernel-wide tile stack"
    );
}



/// Managed (colour-managed) documents must serve the tiled path with tiles
/// byte-identical to the full managed render: `render_device_rect` routes
/// through the linear pipeline and the document settings, exactly what
/// `Engine::render` composes. This is the contract the real-Sketch journey
/// (117-class sRGB documents) depends on.
#[test]
fn managed_document_tiles_are_byte_identical_to_full_render() {
    let mut doc_value: serde_json::Value = serde_json::from_str(&doc()).unwrap();
    doc_value["schemaVersion"] = 3.into();
    doc_value["colorManagement"] = serde_json::json!({
        "documentSpace": "srgb", "referenceWhiteNits": 203, "peakLuminanceNits": 1000
    });
    let mut engine = Engine::new();
    engine
        .load_document(&doc_value.to_string())
        .expect("managed document");
    assert!(engine.color_settings().is_some());
    let options = frame(View { x: -128., y: -64., zoom: 1. }, 1024, 768);
    let full = engine.render(&options).expect("full managed render");
    let assembled = engine
        .render_tiled_frame(&options, None)
        .expect("managed tiled frame");
    assert_eq!(assembled.rgba, full, "managed tiles must equal the full render");
    // And one pan keeps the parity at mid-tile offsets.
    let pan = frame(View { x: -576., y: -288., zoom: 1. }, 1024, 768);
    let pan_full = engine.render(&pan).expect("panned full render");
    let pan_assembled = engine.render_tiled_frame(&pan, None).expect("panned tiles");
    assert_eq!(pan_assembled.rgba, pan_full);
}
